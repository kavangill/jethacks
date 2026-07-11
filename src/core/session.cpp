#include "core/session.hpp"

#include <cstdio>
#include <stdexcept>

namespace cadgod {

void InspectionSession::state(const std::string& phase, const std::string& detail) {
    if (events_.onState) events_.onState(phase, detail);
}

void InspectionSession::log(const std::string& line) {
    if (events_.onLog) events_.onLog(line);
}

void InspectionSession::debug(const std::string& line) {
    if (cfg_.debug && events_.onLog) events_.onLog("[debug] " + line);
}

InspectionSession::Captured InspectionSession::capture(const std::string& viewName) {
    state("capture", "capturing view '" + viewName + "'…");
    // captureView throws on failure — there is no path where reasoning
    // proceeds without a real image on disk.
    std::string path = camera_->captureView(viewName);
    auto added = store_->addFile(path, viewName);
    if (added.duplicate) {
        debug("frame identical to " + added.id + " (content hash match) — will not re-analyze");
        return {added.id, path, true};
    }
    if (events_.onScreenshot) events_.onScreenshot(added.id, path, viewName);
    return {added.id, path, false};
}

VisionFacts InspectionSession::analyze(const Captured& shot, const std::string& viewName,
                                       const std::string& context, bool classify) {
    state("analyze", "analyzing geometry in " + shot.id + " (" + viewName + ")…");
    VisionFacts facts = vision_->extract(shot.path, viewName, context, *kg_, classify);
    ++visionCalls_;
    store_->markSent(shot.id);

    if (!facts.isCadViewport) {
        log("Vision: " + shot.id + " does not show a CAD viewport — frame ignored, no objects recorded.");
        if (events_.onVisionNotes) {
            events_.onVisionNotes(shot.id, "no CAD viewport visible in this frame — ignored");
        }
        return facts;
    }

    std::string notes;
    if (facts.objects.empty()) {
        notes = "no new components identified";
    } else {
        notes = "picked up: ";
        for (std::size_t i = 0; i < facts.objects.size(); ++i) {
            const auto& o = facts.objects[i];
            char conf[16];
            std::snprintf(conf, sizeof conf, "%.0f%%", o.confidence * 100.0);
            if (i) notes += ", ";
            notes += o.id + " (" + o.type + " " + conf + ")";
        }
    }
    if (!facts.featureTree.empty()) {
        notes += " | feature tree: " + std::to_string(facts.featureTree.size()) + " entries";
    }
    if (!facts.notes.empty()) notes += " — " + facts.notes;
    if (events_.onVisionNotes) events_.onVisionNotes(shot.id, notes);

    for (auto obj : facts.objects) {
        obj.screenshots.push_back(shot.id);
        kg_->upsert(obj);
    }
    for (const auto& rel : facts.relationships) {
        kg_->relate(rel.from, rel.kind, rel.to);
    }
    if (!facts.featureTree.empty()) {
        state("graph", "reading feature tree (" + std::to_string(facts.featureTree.size()) + " entries)");
        kg_->addFeatureTree(facts.featureTree);
    }

    char conf[16];
    std::snprintf(conf, sizeof conf, "%.2f", kg_->overallConfidence());
    state("graph", std::to_string(kg_->objectCount()) + " objects, " +
                       std::to_string(kg_->relationshipCount()) + " relationships, confidence " + conf);
    return facts;
}

Report InspectionSession::run(const std::string& userPrompt) {
    // ---- Step 1: initial screenshot (exactly what the user sees) ----------
    Captured initial = capture("initial");

    // ---- Step 2: verify + classify + extract in ONE vision call ------------
    // The extract pass already reports is_cad_viewport, so a separate check
    // call would just re-send the same image. classify=true folds model
    // classification in too — one image send instead of two.
    state("verify", "reading + verifying CAD viewport in " + initial.id + "…");
    std::string context;
    if (!userPrompt.empty()) context += "User description: " + userPrompt + "\n";
    VisionFacts initialFacts = analyze(initial, "initial", context, /*classify=*/true);

    if (!initialFacts.isCadViewport) {
        throw std::runtime_error(
            "No valid CAD viewport detected in the captured screenshot (" + initial.id +
            " shows: " + (initialFacts.notes.empty() ? "unrecognized content" : initialFacts.notes) +
            "). Bring your CAD model into view — or select the correct window — and try again.");
    }
    log("Viewport confirmed: application='" + initialFacts.application + "', model_type='" +
        initialFacts.modelType + "'");

    // ---- Step 3: model understanding / onboarding --------------------------
    context += "Model type: " + initialFacts.modelType;
    if (!initialFacts.purpose.empty()) context += "\nLikely purpose: " + initialFacts.purpose;
    if (initialFacts.modelType == "unknown" && userPrompt.empty() && events_.askUser) {
        state("question", "waiting for user input…");
        std::string answer = events_.askUser(
            "What is this CAD model intended to be?",
            {"Mechanical assembly", "Enclosure", "Robot", "Structural frame", "Single part"});
        if (!answer.empty()) {
            context += "\nUser answer: " + answer;
            log("User clarified model intent: " + answer);
        }
    }

    // ---- Step 5: multi-view inspection loop ---------------------------------
    PlannerAgent planner(cfg_.confidenceThreshold, cfg_.maxSteps,
                         cfg_.minViews > 0 ? cfg_.minViews : 3);
    int step = 1;  // the initial view counts as the first
    while (true) {
        PlanAction action = planner.next(*kg_, step);
        if (action.type == PlanAction::Type::Complete) {
            state("plan", "inspection complete: " + action.reason);
            break;
        }
        state("plan", "requesting next angle: '" + action.viewName + "' (" + action.reason + ")");
        Captured shot;
        try {
            shot = capture(action.viewName);
        } catch (const std::exception& e) {
            // A capture failure mid-loop is fatal only if we have no evidence
            // at all; otherwise we log it loudly and let the planner move on.
            log(std::string("Capture failed: ") + e.what());
            if (store_->size() == 0) throw;
            ++step;
            continue;
        }
        if (!shot.duplicate) analyze(shot, action.viewName, context, /*classify=*/false);
        else log("View '" + action.viewName + "' produced an identical frame — skipping vision call (cost control).");
        ++step;
    }

    if (kg_->objectCount() == 0) {
        throw std::runtime_error(
            "Inspection aborted: no components could be visually confirmed in any captured view. "
            "Refusing to generate a report from unverified data.");
    }

    // ---- Step 6: research ---------------------------------------------------
    state("research", "gathering engineering references…");
    std::vector<Evidence> evidence = research_->research(*kg_);
    for (const auto& e : evidence) debug("research: [" + e.topic + "] " + e.source);

    // ---- Step 7: clarify BEFORE writing the report --------------------------
    // Cheap first pass gets only the essential questions, asked as popups so the
    // user can answer or skip. Answers are folded into context, so the single
    // report below is written WITH them and never re-lists them.
    if (events_.askUser) {
        state("question", "checking what to ask you…");
        std::vector<std::string> questions =
            engineering_->clarifyingQuestions(*kg_, evidence, context);
        std::string answers;
        for (const auto& q : questions) {
            state("question", "asking: " + q);
            std::string a = events_.askUser(q, {});  // free-text; blank = skip
            if (!a.empty()) {
                answers += "Q: " + q + "\nA: " + a + "\n";
                log("Answered: " + q + " -> " + a);
            } else {
                log("Skipped: " + q);
            }
        }
        if (!answers.empty()) {
            context += "\n\nUser answers to clarifying questions (established fact — use these, "
                       "do NOT re-ask):\n" + answers;
        }
    }

    // ---- Step 8: single engineering report ----------------------------------
    state("engineering", "senior engineer review…");
    Report rep = engineering_->report(*kg_, evidence, *store_, context);

    state("done", std::to_string(rep.issues.size()) + " issue(s), " +
                      std::to_string(rep.recommendations.size()) + " rec(s), " +
                      std::to_string(store_->size()) + " screenshot(s), " +
                      std::to_string(visionCalls_) + " vision call(s)");
    return rep;
}

}  // namespace cadgod

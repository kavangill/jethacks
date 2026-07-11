#include "app/app_common.hpp"

#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <unistd.h>

#include "core/claude_client.hpp"
#include "core/env.hpp"

namespace cadgod::app {

namespace {

// ------------------------------------------------------------- dry-run fakes
// Used ONLY when the user explicitly passes --dry-run. Every line of output is
// tagged so canned data can never be mistaken for a real inspection again.

class FakeCamera final : public ICamera {
public:
    explicit FakeCamera(std::string outDir) : outDir_(std::move(outDir)) {}
    std::string captureView(const std::string& viewName) override {
        ++n_;
        std::string path = outDir_ + "/dry_" + std::to_string(n_) + "_" + viewName + ".png";
        std::ofstream f(path, std::ios::binary);
        // "back" repeats the bytes of "front" to exercise dedup.
        std::string content = (viewName == "back") ? "frame:front" : "frame:" + viewName;
        f << content;
        return path;
    }

private:
    std::string outDir_;
    int n_ = 0;
};

class FakeVision final : public IVision {
public:
    VisionFacts extract(const std::string&, const std::string& viewName, const std::string&,
                        const KnowledgeGraph&, bool classify) override {
        VisionFacts facts;
        if (classify) {
            facts.application = "dry-run";
            facts.modelType = "mechanical_assembly";
            facts.purpose = "[DRY RUN] canned data";
        }
        auto obj = [](const char* id, const char* type, double conf,
                      std::vector<std::string> feats) {
            GraphObject o;
            o.id = id;
            o.type = type;
            o.confidence = conf;
            o.features = std::move(feats);
            return o;
        };
        if (viewName == "initial") {
            facts.objects.push_back(obj("demo_bracket_1", "bracket", 0.8, {"[DRY RUN] L-shaped"}));
        } else if (viewName == "front") {
            facts.objects.push_back(obj("demo_shaft_1", "shaft", 0.8, {"[DRY RUN] 5mm dia"}));
            facts.relationships.push_back({"demo_shaft_1", "connected_to", "demo_bracket_1"});
        } else if (viewName == "top") {
            facts.objects.push_back(obj("demo_bearing_1", "bearing", 0.85, {"[DRY RUN] flanged"}));
            facts.featureTree = {"[DRY RUN] Sketch1", "[DRY RUN] Extrude1"};
        } else {
            facts.objects.push_back(obj("demo_plate_1", "plate", 0.9, {"[DRY RUN] base plate"}));
        }
        facts.notes = "[DRY RUN] canned observation for view " + viewName;
        return facts;
    }
};

class FakeEngineering final : public IEngineering {
public:
    std::vector<std::string> clarifyingQuestions(const KnowledgeGraph&,
                                                 const std::vector<Evidence>&,
                                                 const std::string&) override {
        return {"[DRY RUN] what material is the part?"};
    }
    Report report(const KnowledgeGraph& kg, const std::vector<Evidence>&, const ScreenshotStore&,
                  const std::string&) override {
        Report rep;
        Issue i;
        i.title = "[DRY RUN] pipeline check";
        i.description = "loop exercised with " + std::to_string(kg.objectCount()) + " canned objects";
        i.severity = "low";
        i.confidence = 1.0;
        rep.issues.push_back(i);
        rep.recommendations = {"[DRY RUN] run `cadgod inspect` against a real CAD window"};
        return rep;
    }
};

}  // namespace

InspectConfig loadConfig() {
    auto fileEnv = loadEnvFile(".env");
    InspectConfig cfg;
    cfg.apiKey = configValue("ANTHROPIC_API_KEY", fileEnv);
    cfg.model = configValue("CADGOD_MODEL", fileEnv, "claude-opus-4-8");
    try {
        cfg.maxSteps = std::stoi(configValue("CADGOD_MAX_STEPS", fileEnv, "4"));
    } catch (...) {}
    try {
        cfg.confidenceThreshold =
            std::stod(configValue("CADGOD_CONFIDENCE_THRESHOLD", fileEnv, "0.75"));
    } catch (...) {}
    try {
        cfg.minViews = std::stoi(configValue("CADGOD_MIN_VIEWS", fileEnv, "3"));
    } catch (...) {}
    return cfg;
}

platform::WindowInfo resolveTargetWindow(std::string& explanation) {
#ifdef __APPLE__
    auto wm = platform::makeWindowManager();
    auto windows = wm->listWindows();

    for (const auto& w : windows) {
        if (w.isCad) {
            explanation = "matched CAD app: " + w.app + (w.title.empty() ? "" : " — " + w.title);
            return w;
        }
    }
    // Onshape hides inside a browser; without Screen Recording permission the
    // tab title is invisible, so try the largest browser window and let the
    // vision verification pass confirm or reject it.
    const platform::WindowInfo* best = nullptr;
    for (const auto& w : windows) {
        if (w.isBrowser && (!best || w.width * w.height > best->width * best->height)) best = &w;
    }
    if (best) {
        explanation = "no CAD title match; trying largest browser window (" + best->app +
                      ") — screenshot verification will confirm";
        return *best;
    }
    explanation = "no CAD or browser window found; falling back to a full-screen screenshot";
    return platform::mainScreenWindow();
#else
    (void)explanation;
    throw std::runtime_error("window resolution is only implemented on macOS");
#endif
}

Report runInspection(const platform::WindowInfo& window, const InspectConfig& config,
                     const std::string& userPrompt, const SessionEvents& events) {
    std::filesystem::create_directories(config.outDir);

    SessionConfig scfg;
    scfg.maxSteps = config.maxSteps;
    scfg.minViews = config.minViews;
    scfg.confidenceThreshold = config.confidenceThreshold;
    scfg.debug = config.debug;

    ScreenshotStore store;
    KnowledgeGraph kg;

    if (config.dryRun) {
        FakeCamera camera(config.outDir);
        FakeVision vision;
        ResearchAgent research;
        FakeEngineering engineering;
        InspectionSession session(scfg, &camera, &vision, &research, &engineering, &store, &kg,
                                  events);
        return session.run(userPrompt);
    }

    if (config.apiKey.empty()) {
        throw std::runtime_error("ANTHROPIC_API_KEY is not set (put it in .env)");
    }

#ifdef __APPLE__
    // Cursor input lands on whatever is frontmost — bring the CAD app forward.
    if (window.pid > 0) {
        platform::activateApp(window.pid);
        usleep(800000);
    }

    auto input = platform::makeInputController();
    auto capturer = platform::makeScreenCapturer();
    OrbitStyle style = orbitStyleForApp(window.app);
    std::function<void(const std::string&)> camLog;
    if (config.debug && events.onLog) camLog = events.onLog;
    CameraAgent camera(input.get(), capturer.get(), window, config.outDir, style, camLog);

    if (events.onLog) {
        events.onLog("Attached to '" + window.app + "' (window " + std::to_string(window.id) +
                     ", " + std::to_string(window.width) + "x" + std::to_string(window.height) +
                     "), orbit style: " + orbitStyleName(style));
    }

    CurlTransport transport;
    ClaudeClient client(config.apiKey, config.model, &transport);
    VisionAgent vision(&client);
    ResearchAgent research;
    EngineeringAgent engineering(&client);

    InspectionSession session(scfg, &camera, &vision, &research, &engineering, &store, &kg,
                              events);
    return session.run(userPrompt);
#else
    throw std::runtime_error("real inspection is only implemented on macOS");
#endif
}

}  // namespace cadgod::app

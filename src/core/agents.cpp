#include "core/agents.hpp"

#include <algorithm>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace cadgod {

// ---------------------------------------------------------------- Planner --

const std::vector<std::string>& PlannerAgent::standardViews() {
    static const std::vector<std::string> views = {
        "isometric", "front", "top", "right", "back", "bottom", "zoom_detail", "left",
    };
    return views;
}

PlanAction PlannerAgent::next(const KnowledgeGraph& kg, int stepsTaken) const {
    const auto& views = standardViews();
    if (stepsTaken >= maxSteps_) {
        return {PlanAction::Type::Complete, "", "max steps reached"};
    }
    if (stepsTaken >= static_cast<int>(views.size())) {
        return {PlanAction::Type::Complete, "", "all standard views captured"};
    }
    if (stepsTaken >= minSteps_ && kg.overallConfidence() >= threshold_) {
        return {PlanAction::Type::Complete, "", "confidence threshold reached"};
    }
    return {PlanAction::Type::CaptureView, views[static_cast<std::size_t>(stepsTaken)],
            "gathering evidence"};
}

// ----------------------------------------------------------------- Camera --

OrbitStyle orbitStyleForApp(const std::string& appName) {
    std::string a = appName;
    std::transform(a.begin(), a.end(), a.begin(), ::tolower);
    if (a.find("fusion") != std::string::npos) return OrbitStyle::ShiftMiddleDrag;
    if (platform::isBrowserApp(appName) || a.find("onshape") != std::string::npos ||
        a.find("screen") != std::string::npos) {
        return OrbitStyle::RightDrag;  // Onshape default: right-drag rotates
    }
    return OrbitStyle::MiddleDrag;
}

const char* orbitStyleName(OrbitStyle style) {
    switch (style) {
        case OrbitStyle::ShiftMiddleDrag: return "shift+middle-drag (Fusion 360)";
        case OrbitStyle::RightDrag: return "right-drag (Onshape)";
        case OrbitStyle::MiddleDrag: default: return "middle-drag (generic)";
    }
}

namespace {

// Orbit drag deltas (pixels) applied from the previous orientation to reach an
// approximation of each named view. Exact angles are not required for the MVP;
// the planner only needs meaningfully different vantage points.
struct OrbitDelta {
    int dx;
    int dy;
    int zoom;  // scroll clicks after orbiting (zoom_detail)
};

OrbitDelta deltaForView(const std::string& view) {
    if (view == "initial") return {0, 0, 0};   // capture exactly what the user sees
    if (view == "isometric") return {60, 40, 0};
    if (view == "front") return {-120, 60, 0};
    if (view == "top") return {0, -180, 0};
    if (view == "right") return {180, 120, 0};
    if (view == "back") return {180, 0, 0};
    if (view == "bottom") return {0, 180, 0};
    if (view == "left") return {180, 0, 0};
    if (view == "zoom_detail") return {60, -40, 5};
    return {90, 45, 0};
}

}  // namespace

CameraAgent::CameraAgent(platform::InputController* input, platform::ScreenCapturer* capturer,
                         platform::WindowInfo window, std::string outDir, OrbitStyle style,
                         std::function<void(const std::string&)> debugLog)
    : input_(input),
      capturer_(capturer),
      window_(std::move(window)),
      outDir_(std::move(outDir)),
      style_(style),
      debugLog_(std::move(debugLog)) {}

std::string CameraAgent::captureView(const std::string& viewName) {
    int cx = window_.x + window_.width / 2;
    int cy = window_.y + window_.height / 2;

    OrbitDelta d = deltaForView(viewName);
    if (d.dx != 0 || d.dy != 0) {
        platform::Modifiers mods;
        platform::MouseButton button;
        switch (style_) {
            case OrbitStyle::ShiftMiddleDrag:
                button = platform::MouseButton::Middle;
                mods.shift = true;
                break;
            case OrbitStyle::RightDrag:
                button = platform::MouseButton::Right;
                break;
            case OrbitStyle::MiddleDrag:
            default:
                button = platform::MouseButton::Middle;
                break;
        }
        if (debugLog_) {
            debugLog_("camera: orbit drag (" + std::to_string(cx) + "," + std::to_string(cy) +
                      ") -> (" + std::to_string(cx + d.dx) + "," + std::to_string(cy + d.dy) +
                      ") via " + orbitStyleName(style_));
        }
        input_->drag(cx, cy, cx + d.dx, cy + d.dy, button, mods);
    }
    if (d.zoom != 0) {
        if (debugLog_) debugLog_("camera: zoom scroll " + std::to_string(d.zoom));
        input_->scroll(cx, cy, d.zoom);
    }

    ++shotIndex_;
    std::string path = outDir_ + "/view_" + std::to_string(shotIndex_) + "_" + viewName + ".png";
    if (!capturer_->capture(window_, path)) {
        throw std::runtime_error(
            "screenshot capture FAILED for view '" + viewName + "' (window " +
            std::to_string(window_.id) +
            "). Check Screen Recording permission and that the window is on screen.");
    }
    if (debugLog_) debugLog_("camera: captured " + path);
    return path;
}

// ----------------------------------------------------------------- Vision --

Json VisionAgent::outputSchema(bool classify) {
    Json objProps = Json::object();
    objProps["id"] = Json::parse(R"({"type":"string","description":"stable snake_case id, e.g. bracket_1"})");
    objProps["type"] = Json::parse(R"({"type":"string","description":"component type: motor, shaft, bracket, bearing, fastener, gear, plate, hole_pattern, enclosure, unclassified"})");
    objProps["confidence"] = Json::parse(R"({"type":"number","description":"0 to 1; how certain the identification is from THIS image"})");
    objProps["features"] = Json::parse(R"({"type":"array","items":{"type":"string"}})");
    objProps["connected_to"] = Json::parse(R"({"type":"array","items":{"type":"string"}})");

    Json objSchema = Json::object();
    objSchema["type"] = "object";
    objSchema["properties"] = objProps;
    objSchema["required"] = Json::parse(R"(["id","type","confidence","features","connected_to"])");
    objSchema["additionalProperties"] = false;

    Json objects = Json::object();
    objects["type"] = "array";
    objects["items"] = objSchema;

    Json props = Json::object();
    props["is_cad_viewport"] = Json::parse(
        R"({"type":"boolean","description":"false if this image does not actually show a CAD 3D viewport"})");
    props["objects"] = objects;
    props["feature_tree"] = Json::parse(
        R"({"type":"array","items":{"type":"string"},"description":"entries visible in a feature tree / parts list panel, verbatim"})");
    props["notes"] = Json::parse(R"({"type":"string","description":"one sentence describing what the screenshot shows"})");

    Json required = Json::parse(R"(["is_cad_viewport","objects","feature_tree","notes"])");
    if (classify) {
        // Only the first frame classifies the model — folds the old, separate
        // cadCheck call into this one so the initial image is sent ONCE.
        props["application"] = Json::parse(
            R"({"type":"string","description":"CAD app if identifiable (Onshape, Fusion 360, SolidWorks, ...) else 'unknown'"})");
        props["model_type"] = Json::parse(
            R"({"type":"string","enum":["mechanical_assembly","enclosure","robot","structural_frame","single_part","unknown"]})");
        props["purpose"] = Json::parse(
            R"({"type":"string","description":"best guess at what the model is for; empty string if unclear"})");
        required.push_back("application");
        required.push_back("model_type");
        required.push_back("purpose");
    }

    Json schema = Json::object();
    schema["type"] = "object";
    schema["properties"] = props;
    schema["required"] = required;
    schema["additionalProperties"] = false;
    return schema;
}

Json VisionAgent::imageMessage(const std::string& imagePath, const std::string& prompt) {
    std::ifstream f(imagePath, std::ios::binary);
    if (!f) throw std::runtime_error("VisionAgent: cannot read image " + imagePath);
    std::ostringstream ss;
    ss << f.rdbuf();
    std::string bytes = ss.str();
    if (bytes.empty()) throw std::runtime_error("VisionAgent: image file is empty: " + imagePath);

    Json content = Json::array();
    content.push_back(ClaudeClient::imageBlock(ClaudeClient::mediaTypeForPath(imagePath),
                                               ClaudeClient::base64Encode(bytes)));
    content.push_back(ClaudeClient::textBlock(prompt));
    Json messages = Json::array();
    messages.push_back(ClaudeClient::userMessage(content));
    return messages;
}

VisionFacts VisionAgent::extract(const std::string& imagePath, const std::string& viewName,
                                 const std::string& context, const KnowledgeGraph& known,
                                 bool classify) {
    std::string system =
        "You are the Vision Agent of a CAD inspection system. You ONLY report objects that are "
        "actually visible in this screenshot: parts, holes, fasteners, bearings, shafts, motors, "
        "gears, brackets, plates. HARD RULES:\n"
        "1. Never assume or invent components. If you cannot clearly see it, it does not exist.\n"
        "2. If a shape cannot be confidently identified, report type 'unclassified' with low "
        "confidence — never guess a specific component type.\n"
        "3. Be strict about is_cad_viewport: it is false unless a 3D CAD viewport with an actual "
        "model is clearly visible. A browser showing something else, a desktop, a code editor, or "
        "an empty CAD scene all count as false — set it false and return an empty objects list.\n"
        "4. If an object matches one in the known-objects list, reuse its exact id; only "
        "introduce new snake_case ids for objects not yet known.\n"
        "5. If a feature tree / parts list panel is visible (e.g. the Onshape left panel), copy "
        "its entry names verbatim into feature_tree.\n"
        "6. You NEVER give engineering advice — facts only.";
    if (classify) {
        system +=
            "\n7. This is the FIRST frame: also classify the model (application, model_type, "
            "purpose) conservatively from what is visible; use 'unknown' when unsure.";
    }

    std::string prompt = "Current view: " + viewName + "\n";
    if (!context.empty()) {
        prompt += "\nContext (for identification only — NEVER report objects that are not "
                  "visible in the image):\n" + context + "\n";
    }
    // Skip the known-objects summary on the first frame (it is empty) to save
    // input tokens; include it only once there is prior knowledge to reuse.
    if (known.objectCount() > 0) {
        prompt += "\nKnown objects so far:\n" + known.summary();
    }
    prompt += "\nExtract every component and relationship visible in this screenshot.";

    ClaudeOptions opts;
    opts.maxTokens = 2048;
    // No extended thinking: the model's power should go into reading the image
    // and filling the structured schema, not lengthy chain-of-thought. This is
    // the token-heavy step (runs once per view), so keeping it lean matters.
    opts.outputSchema = outputSchema(classify);
    ClaudeResult result = client_->complete(system, imageMessage(imagePath, prompt), opts);
    if (!result.ok) throw std::runtime_error("VisionAgent: " + result.error);

    Json parsed = Json::parse(result.text);
    VisionFacts facts;
    if (const Json* v = parsed.find("is_cad_viewport"); v && v->isBool()) {
        facts.isCadViewport = v->asBool();
    }
    if (classify) {
        facts.application = parsed.getString("application", "unknown");
        facts.modelType = parsed.getString("model_type", "unknown");
        facts.purpose = parsed.getString("purpose");
    }
    facts.notes = parsed.getString("notes");
    if (const Json* tree = parsed.find("feature_tree"); tree && tree->isArray()) {
        for (const auto& t : tree->items()) {
            if (t.isString()) facts.featureTree.push_back(t.asString());
        }
    }
    if (!facts.isCadViewport) return facts;  // no objects from non-CAD frames
    if (const Json* objs = parsed.find("objects"); objs && objs->isArray()) {
        for (const auto& j : objs->items()) {
            GraphObject obj;
            obj.id = j.getString("id");
            obj.type = j.getString("type", "unclassified");
            obj.confidence = j.getNumber("confidence");
            if (const Json* feats = j.find("features"); feats && feats->isArray()) {
                for (const auto& ft : feats->items()) {
                    if (ft.isString()) obj.features.push_back(ft.asString());
                }
            }
            if (const Json* conns = j.find("connected_to"); conns && conns->isArray()) {
                for (const auto& c : conns->items()) {
                    if (c.isString()) facts.relationships.push_back({obj.id, "connected_to", c.asString()});
                }
            }
            facts.objects.push_back(std::move(obj));
        }
    }
    return facts;
}

// --------------------------------------------------------------- Research --

std::vector<Evidence> ResearchAgent::research(const KnowledgeGraph& kg) {
    std::vector<Evidence> out;
    auto has = [&](const char* type) { return !kg.byType(type).empty(); };

    if (has("bearing")) {
        out.push_back({"bearing fits",
                       "Rotating shaft in bearing inner race typically uses an interference fit "
                       "(k6/m6 on the shaft) with a transition/clearance fit (H7) on the housing; "
                       "verify axial retention (shoulder, circlip, or preload).",
                       "ISO 286 fit tables / SKF mounting guidelines"});
    }
    if (has("fastener") || has("bolt") || has("screw")) {
        out.push_back({"fastener access & clearance",
                       "Clearance holes per ISO 273 (e.g. M3 -> 3.4 mm medium fit). Verify tool "
                       "access: hex keys need straight-line clearance to the screw axis, and "
                       "threaded engagement should be >= 1.5x diameter in aluminum.",
                       "ISO 273 / Machinery's Handbook"});
    }
    if (has("motor")) {
        out.push_back({"motor mounting",
                       "Motors should mount on >= 2 fasteners with the pilot boss located, shaft "
                       "aligned to the driven component within coupling tolerance, and heat "
                       "dissipation path considered for continuous duty.",
                       "NEMA / manufacturer datasheet conventions"});
    }
    if (has("gear")) {
        out.push_back({"gear mesh",
                       "Spur gear center distance = (z1+z2)*m/2; verify backlash allowance and "
                       "that shafts are supported on both sides of the mesh to avoid deflection.",
                       "AGMA fundamentals"});
    }
    if (has("shaft")) {
        out.push_back({"shaft design",
                       "Check stress concentrations at shoulders and keyways (generous fillets), "
                       "and that cantilevered lengths are minimized relative to bearing spacing.",
                       "Shigley's Mechanical Engineering Design"});
    }
    if (out.empty()) {
        out.push_back({"general DFM",
                       "Verify wall thicknesses are manufacturable, internal corners have fillets "
                       "or reliefs for machining, and mating parts have explicit tolerances.",
                       "General DFM guidelines"});
    }
    return out;
}

// ------------------------------------------------------------ Engineering --

Json EngineeringAgent::outputSchema() {
    Json issueProps = Json::object();
    issueProps["title"] = Json::parse(R"({"type":"string","description":"terse, <= 8 words"})");
    issueProps["description"] = Json::parse(
        R"({"type":"string","description":"ONE compact line, <= 20 words, telegraphic. Reference object/screenshot ids. No paragraphs."})");
    issueProps["severity"] = Json::parse(R"({"type":"string","enum":["low","medium","high"]})");
    issueProps["confidence"] = Json::parse(R"({"type":"number","description":"0 to 1"})");
    issueProps["evidence"] = Json::parse(R"({"type":"array","items":{"type":"string"}})");

    Json issueSchema = Json::object();
    issueSchema["type"] = "object";
    issueSchema["properties"] = issueProps;
    issueSchema["required"] = Json::parse(R"(["title","description","severity","confidence","evidence"])");
    issueSchema["additionalProperties"] = false;

    Json issues = Json::object();
    issues["type"] = "array";
    issues["items"] = issueSchema;

    Json recs = Json::object();
    recs["type"] = "array";
    recs["items"] = Json::parse(
        R"({"type":"string","description":"one short imperative jot note, <= 16 words, no paragraph"})");

    Json props = Json::object();
    props["issues"] = issues;
    props["recommendations"] = recs;

    Json schema = Json::object();
    schema["type"] = "object";
    schema["properties"] = props;
    schema["required"] = Json::parse(R"(["issues","recommendations"])");
    schema["additionalProperties"] = false;
    return schema;
}

Json EngineeringAgent::questionsSchema() {
    Json props = Json::object();
    // NOTE: no `maxItems` — the Anthropic structured-output schema rejects it;
    // the "at most 4" cap is enforced in the system prompt instead.
    props["questions"] = Json::parse(
        R"({"type":"array","items":{"type":"string","description":"one short question, <= 20 words"}})");
    Json schema = Json::object();
    schema["type"] = "object";
    schema["properties"] = props;
    schema["required"] = Json::parse(R"(["questions"])");
    schema["additionalProperties"] = false;
    return schema;
}

std::vector<std::string> EngineeringAgent::clarifyingQuestions(const KnowledgeGraph& kg,
                                                               const std::vector<Evidence>& evidence,
                                                               const std::string& context) {
    const std::string system =
        "You are a senior mechanical engineer about to review a CAD model. FIRST, list only the "
        "few (at most 4) highest-impact questions whose answers you genuinely need to give a "
        "useful review — dimensions, spacing, loads, material, or design intent that the "
        "knowledge graph does not contain. Ask nothing you can already infer. Each question short "
        "(<= 20 words). If nothing important is missing, return an empty list.";
    std::string prompt;
    if (!context.empty()) prompt += "Context:\n" + context + "\n\n";
    prompt += "Visually confirmed objects:\n" + kg.summary();
    (void)evidence;
    prompt += "\nList the essential clarifying questions.";

    Json content = Json::array();
    content.push_back(ClaudeClient::textBlock(prompt));
    Json messages = Json::array();
    messages.push_back(ClaudeClient::userMessage(content));

    ClaudeOptions opts;
    opts.maxTokens = 512;  // cheap probe
    opts.outputSchema = questionsSchema();
    ClaudeResult result = client_->complete(system, messages, opts);
    if (!result.ok) throw std::runtime_error("EngineeringAgent(questions): " + result.error);

    std::vector<std::string> out;
    Json parsed = Json::parse(result.text);
    if (const Json* qs = parsed.find("questions"); qs && qs->isArray()) {
        for (const auto& q : qs->items()) {
            if (q.isString() && !q.asString().empty()) out.push_back(q.asString());
        }
    }
    return out;
}

Report EngineeringAgent::report(const KnowledgeGraph& kg, const std::vector<Evidence>& evidence,
                                const ScreenshotStore& shots, const std::string& context) {
    const std::string system =
        "You are the Engineering Agent: a senior mechanical engineer writing a design review. "
        "STYLE: terse jot notes, NOT prose. No paragraphs, no full sentences where a fragment "
        "works. Each issue description is ONE line (<= 20 words). Recommendations are short "
        "imperatives (<= 16 words). Be specific and quantitative where possible.\n"
        "HARD CONSTRAINT: only discuss objects in the knowledge graph — never invent components. "
        "Reference object/screenshot ids. Assign 0-1 confidence per issue.\n"
        "The user has already answered clarifying questions (in the context). Treat those answers "
        "as established fact, use them, and do NOT re-ask or list them as unknown. Do not output "
        "any questions or 'missing information' section — that step already happened.";

    std::string prompt;
    if (!context.empty()) prompt += "Model context:\n" + context + "\n\n";
    prompt += "Knowledge graph of visually confirmed objects (the ONLY objects you may discuss):\n" +
              kg.summary() + "\n";
    prompt += "\nScreenshots captured:\n";
    for (const auto& s : shots.all()) {
        prompt += "- " + s.id + ": view '" + s.viewName + "'\n";
    }
    prompt += "\nEngineering references gathered by the Research Agent:\n";
    for (const auto& e : evidence) {
        prompt += "- [" + e.topic + "] " + e.summary + " (source: " + e.source + ")\n";
    }
    prompt += "\nProduce the design review now.";

    Json content = Json::array();
    content.push_back(ClaudeClient::textBlock(prompt));
    Json messages = Json::array();
    messages.push_back(ClaudeClient::userMessage(content));

    ClaudeOptions opts;
    opts.maxTokens = 1600;  // compact jot-note report -> fewer output tokens
    opts.outputSchema = outputSchema();
    ClaudeResult result = client_->complete(system, messages, opts);
    if (!result.ok) throw std::runtime_error("EngineeringAgent: " + result.error);

    Json parsed = Json::parse(result.text);
    Report rep;
    if (const Json* issues = parsed.find("issues"); issues && issues->isArray()) {
        for (const auto& j : issues->items()) {
            Issue issue;
            issue.title = j.getString("title");
            issue.description = j.getString("description");
            issue.severity = j.getString("severity", "medium");
            issue.confidence = j.getNumber("confidence");
            if (const Json* ev = j.find("evidence"); ev && ev->isArray()) {
                for (const auto& e : ev->items()) {
                    if (e.isString()) issue.evidence.push_back(e.asString());
                }
            }
            rep.issues.push_back(std::move(issue));
        }
    }
    if (const Json* arr = parsed.find("recommendations"); arr && arr->isArray()) {
        for (const auto& s : arr->items()) {
            if (s.isString()) rep.recommendations.push_back(s.asString());
        }
    }
    return rep;
}

// ----------------------------------------------------------------- Report --

std::string Report::toMarkdown() const {
    // Compact, jot-note style with dividers the UI renders as horizontal rules.
    std::string md = "## Issues\n";
    if (issues.empty()) {
        md += "_None found._\n";
    }
    for (const auto& i : issues) {
        char conf[16];
        std::snprintf(conf, sizeof conf, "%.0f%%", i.confidence * 100.0);
        // ▸ **high · 60%** Title — desc  [shot-2, rod_1]
        md += "▸ **" + i.severity + " · " + conf + "**  " + i.title + " — " + i.description;
        if (!i.evidence.empty()) {
            md += "  [";
            for (std::size_t k = 0; k < i.evidence.size(); ++k) {
                if (k) md += ", ";
                md += i.evidence[k];
            }
            md += "]";
        }
        md += "\n";
    }
    md += "\n---\n## Recommendations\n";
    if (recommendations.empty()) {
        md += "_None._\n";
    }
    for (const auto& r : recommendations) md += "▸ " + r + "\n";
    return md;
}

}  // namespace cadgod

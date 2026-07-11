#pragma once
// The 5-agent architecture:
//   Planner     — decides the next view / when inspection is complete (deterministic)
//   Camera      — executes CAD navigation + captures screenshots
//   Vision      — extracts facts only from real screenshots (LLM, image input)
//   Research    — returns engineering references as evidence
//   Engineering — final reasoning: issues, confidence, recommendations (LLM)
//
// Anti-hallucination contract: the Vision agent may only report what is
// visible; anything uncertain is "unclassified"; a frame without a CAD
// viewport yields no objects. Engineering may only reference knowledge-graph
// objects.

#include <functional>
#include <string>
#include <vector>

#include "core/claude_client.hpp"
#include "core/knowledge_graph.hpp"
#include "core/screenshot_store.hpp"
#include "platform/platform.hpp"

namespace cadgod {

// ---------------------------------------------------------------- Planner --

struct PlanAction {
    enum class Type { CaptureView, Complete } type = Type::Complete;
    std::string viewName;
    std::string reason;
};

class PlannerAgent {
public:
    PlannerAgent(double confidenceThreshold = 0.75, int maxSteps = 6, int minSteps = 3)
        : threshold_(confidenceThreshold), maxSteps_(maxSteps), minSteps_(minSteps) {}

    PlanAction next(const KnowledgeGraph& kg, int stepsTaken) const;
    static const std::vector<std::string>& standardViews();

    double threshold() const { return threshold_; }
    int maxSteps() const { return maxSteps_; }
    int minSteps() const { return minSteps_; }

private:
    double threshold_;
    int maxSteps_;
    int minSteps_;
};

// ----------------------------------------------------------------- Camera --

class ICamera {
public:
    virtual ~ICamera() = default;
    // Moves the CAD camera toward the named view and captures a screenshot.
    // "initial" captures without moving anything. Returns the image file path.
    virtual std::string captureView(const std::string& viewName) = 0;
};

// How the target application orbits its 3D view.
enum class OrbitStyle {
    ShiftMiddleDrag,  // Fusion 360
    RightDrag,        // Onshape (incl. in-browser)
    MiddleDrag,       // generic fallback
};

OrbitStyle orbitStyleForApp(const std::string& appName);
const char* orbitStyleName(OrbitStyle style);

class CameraAgent : public ICamera {
public:
    CameraAgent(platform::InputController* input, platform::ScreenCapturer* capturer,
                platform::WindowInfo window, std::string outDir, OrbitStyle style,
                std::function<void(const std::string&)> debugLog = {});
    std::string captureView(const std::string& viewName) override;

private:
    platform::InputController* input_;
    platform::ScreenCapturer* capturer_;
    platform::WindowInfo window_;
    std::string outDir_;
    OrbitStyle style_;
    std::function<void(const std::string&)> debugLog_;
    int shotIndex_ = 0;
};

// ----------------------------------------------------------------- Vision --

// A single vision pass both verifies the frame IS a CAD viewport and extracts
// facts — one image send does the work of what used to be two calls. The
// classification fields are only meaningful on the first (initial) frame.
struct VisionFacts {
    bool isCadViewport = true;  // false -> frame ignored, no objects merged
    std::string application;    // "Onshape", "Fusion 360", ... (initial frame)
    std::string modelType;      // mechanical_assembly | enclosure | robot | structural_frame | single_part | unknown
    std::string purpose;        // best guess at what the model is for (initial frame)
    std::vector<GraphObject> objects;
    std::vector<Relationship> relationships;
    std::vector<std::string> featureTree;  // visible feature-tree / parts-list entries
    std::string notes;
};

class IVision {
public:
    virtual ~IVision() = default;
    // classify=true on the first frame -> also fill application/modelType/purpose
    // (and verify the CAD viewport). On later frames it's pure fact extraction.
    virtual VisionFacts extract(const std::string& imagePath, const std::string& viewName,
                                const std::string& context, const KnowledgeGraph& known,
                                bool classify) = 0;
};

class VisionAgent : public IVision {
public:
    explicit VisionAgent(ClaudeClient* client) : client_(client) {}
    VisionFacts extract(const std::string& imagePath, const std::string& viewName,
                        const std::string& context, const KnowledgeGraph& known,
                        bool classify) override;

    static Json outputSchema(bool classify);

private:
    Json imageMessage(const std::string& imagePath, const std::string& prompt);
    ClaudeClient* client_;
};

// --------------------------------------------------------------- Research --

struct Evidence {
    std::string topic;
    std::string summary;
    std::string source;
};

class IResearch {
public:
    virtual ~IResearch() = default;
    virtual std::vector<Evidence> research(const KnowledgeGraph& kg) = 0;
};

// Offline reference library keyed by component type. Returns evidence only —
// no API cost. (A future version can add web lookup behind this interface.)
class ResearchAgent : public IResearch {
public:
    std::vector<Evidence> research(const KnowledgeGraph& kg) override;
};

// ------------------------------------------------------------ Engineering --

struct Issue {
    std::string title;
    std::string description;
    std::string severity;  // low | medium | high
    double confidence = 0.0;
    std::vector<std::string> evidence;  // screenshot ids / object ids / references
};

struct Report {
    std::vector<Issue> issues;
    std::vector<std::string> recommendations;
    std::string toMarkdown() const;
};

class IEngineering {
public:
    virtual ~IEngineering() = default;
    // Cheap first pass: the few highest-impact questions whose answers would
    // change the review. Empty if nothing important is missing. These get asked
    // as popups BEFORE the report, so the report never re-lists them.
    virtual std::vector<std::string> clarifyingQuestions(const KnowledgeGraph& kg,
                                                         const std::vector<Evidence>& evidence,
                                                         const std::string& context) = 0;
    virtual Report report(const KnowledgeGraph& kg, const std::vector<Evidence>& evidence,
                          const ScreenshotStore& shots, const std::string& context) = 0;
};

class EngineeringAgent : public IEngineering {
public:
    explicit EngineeringAgent(ClaudeClient* client) : client_(client) {}
    std::vector<std::string> clarifyingQuestions(const KnowledgeGraph& kg,
                                                 const std::vector<Evidence>& evidence,
                                                 const std::string& context) override;
    Report report(const KnowledgeGraph& kg, const std::vector<Evidence>& evidence,
                  const ScreenshotStore& shots, const std::string& context) override;

    static Json outputSchema();
    static Json questionsSchema();

private:
    ClaudeClient* client_;
};

}  // namespace cadgod

#pragma once
// InspectionSession — the inspection state machine:
//
//   attach -> capture(initial) -> verify viewport -> [ask user if unknown]
//     -> analyze -> loop { plan -> capture -> dedup -> analyze -> graph }
//     -> research -> engineering -> report
//
// Hard rules enforced here:
//   * No AI reasoning without a confirmed, non-empty screenshot on disk.
//   * If the verification pass says the frame is not a CAD viewport, the
//     session FAILS (throws) — it never continues on fake or assumed data.
//   * Minimum number of views is enforced even for simple models.
// Every step emits events so a UI can show the system working.

#include <functional>
#include <string>
#include <vector>

#include "core/agents.hpp"

namespace cadgod {

// Phase keys emitted via onState (stable strings for UI mapping):
//   attach, capture, verify, question, analyze, graph, plan, research,
//   engineering, done
struct SessionEvents {
    std::function<void(const std::string& phase, const std::string& detail)> onState;
    // A screenshot exists on disk and was registered (show it in the UI).
    std::function<void(const std::string& shotId, const std::string& path,
                       const std::string& view)> onScreenshot;
    // What vision actually picked up from that screenshot (note under thumbnail).
    std::function<void(const std::string& shotId, const std::string& notes)> onVisionNotes;
    std::function<void(const std::string& line)> onLog;
    // Blocking clarification question. Returns the user's answer (may be free
    // text or one of the options). If unset, questions are skipped.
    std::function<std::string(const std::string& question,
                              const std::vector<std::string>& options)> askUser;
};

struct SessionConfig {
    int maxSteps = 6;
    int minViews = 3;  // hard minimum screenshots analyzed, even for simple models
    double confidenceThreshold = 0.75;
    bool debug = false;
};

class InspectionSession {
public:
    InspectionSession(SessionConfig cfg, ICamera* camera, IVision* vision, IResearch* research,
                      IEngineering* engineering, ScreenshotStore* store, KnowledgeGraph* kg,
                      SessionEvents events)
        : cfg_(cfg),
          camera_(camera),
          vision_(vision),
          research_(research),
          engineering_(engineering),
          store_(store),
          kg_(kg),
          events_(std::move(events)) {}

    // Runs the full inspection. userPrompt is the user's own description of the
    // model (may be empty). Throws std::runtime_error on hard failure (no CAD
    // viewport, capture failure, API failure) — callers must surface the error
    // and stop; there is no silent fallback.
    Report run(const std::string& userPrompt);

    int visionCalls() const { return visionCalls_; }

private:
    void state(const std::string& phase, const std::string& detail);
    void log(const std::string& line);
    void debug(const std::string& line);
    // Captures a view, registers it, emits events. Returns {shotId, path,
    // duplicate}.
    struct Captured {
        std::string id;
        std::string path;
        bool duplicate = false;
    };
    Captured capture(const std::string& viewName);
    // Runs vision on a confirmed screenshot and merges results into the graph.
    // classify=true on the first frame -> also verify the viewport + classify
    // the model. Returns the raw facts so the caller can act on them.
    VisionFacts analyze(const Captured& shot, const std::string& viewName,
                        const std::string& context, bool classify);

    SessionConfig cfg_;
    ICamera* camera_;
    IVision* vision_;
    IResearch* research_;
    IEngineering* engineering_;
    ScreenshotStore* store_;
    KnowledgeGraph* kg_;
    SessionEvents events_;
    int visionCalls_ = 0;
};

}  // namespace cadgod

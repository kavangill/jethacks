#pragma once
// Shared wiring used by both the CLI and the overlay app: config loading,
// window resolution, and running an InspectionSession (real or explicit
// dry-run — there is NO silent dry-run fallback anymore).

#include <string>
#include <vector>

#include "core/session.hpp"
#include "platform/platform.hpp"

namespace cadgod::app {

struct InspectConfig {
    bool dryRun = false;  // ONLY when explicitly requested (CLI --dry-run)
    int maxSteps = 6;
    int minViews = 3;
    double confidenceThreshold = 0.75;
    bool debug = false;
    std::string outDir = "inspection_out";
    std::string model = "claude-opus-4-8";
    std::string apiKey;
};

// Loads .env + process env into an InspectConfig (model, thresholds, key).
InspectConfig loadConfig();

// Picks the best inspection target from the currently open windows:
//   1. a window whose app/title matches a known CAD app,
//   2. otherwise the largest browser window (Onshape hides in Chrome — the
//      session's screenshot verification will confirm or reject it),
//   3. otherwise the full screen as a screenshot-only fallback.
// `explanation` receives a human-readable description of the choice.
platform::WindowInfo resolveTargetWindow(std::string& explanation);

// Runs a full inspection session against the given window. Throws on failure.
// userPrompt is the user's description of the model (may be empty).
Report runInspection(const platform::WindowInfo& window, const InspectConfig& config,
                     const std::string& userPrompt, const SessionEvents& events);

}  // namespace cadgod::app

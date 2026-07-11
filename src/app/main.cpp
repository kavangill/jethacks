// CADGOD CLI — CAD Inspection Copilot.
//   cadgod windows              list detected windows (CAD/browser flagged)
//   cadgod smoke                one tiny API call to verify the key works
//   cadgod inspect [--dry-run] [--window-id N] [--prompt "..."] [--debug]
//                               run the full inspection state machine

#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include "app/app_common.hpp"
#include "core/claude_client.hpp"
#include "core/env.hpp"

using namespace cadgod;

namespace {

int cmdWindows() {
#ifdef __APPLE__
    if (!platform::hasScreenRecordingPermission()) {
        std::printf("NOTE: Screen Recording permission not granted — window TITLES are hidden,\n"
                    "so Onshape tabs cannot be matched by name. Requesting permission…\n\n");
        platform::requestScreenRecordingPermission();
    }
    auto wm = platform::makeWindowManager();
    auto windows = wm->listWindows();
    if (windows.empty()) {
        std::printf("No windows found.\n");
        return 1;
    }
    std::printf("%-10s %-8s %-4s %-8s %-24s %s\n", "WINDOW ID", "PID", "CAD", "BROWSER", "APP", "TITLE");
    for (const auto& w : windows) {
        std::printf("%-10u %-8d %-4s %-8s %-24.24s %.50s\n", w.id, w.pid, w.isCad ? "yes" : "-",
                    w.isBrowser ? "yes" : "-", w.app.c_str(), w.title.c_str());
    }
    return 0;
#else
    std::printf("window listing is only implemented on macOS\n");
    return 1;
#endif
}

int cmdSmoke() {
    app::InspectConfig cfg = app::loadConfig();
    if (cfg.apiKey.empty()) {
        std::fprintf(stderr, "error: ANTHROPIC_API_KEY not set (put it in .env)\n");
        return 1;
    }
    CurlTransport transport(60);
    ClaudeClient client(cfg.apiKey, cfg.model, &transport);

    Json content = Json::array();
    content.push_back(ClaudeClient::textBlock("Reply with exactly: CADGOD OK"));
    Json messages = Json::array();
    messages.push_back(ClaudeClient::userMessage(content));

    ClaudeOptions opts;
    opts.maxTokens = 32;
    ClaudeResult r = client.complete("", messages, opts);
    if (!r.ok) {
        std::fprintf(stderr, "API smoke test FAILED: %s\n", r.error.c_str());
        return 1;
    }
    std::printf("API smoke test OK (model %s)\n  response: %s\n  usage: %ld in / %ld out tokens\n",
                cfg.model.c_str(), r.text.c_str(), r.inputTokens, r.outputTokens);
    return 0;
}

int cmdInspect(const std::vector<std::string>& args) {
    app::InspectConfig cfg = app::loadConfig();
    unsigned windowId = 0;
    std::string userPrompt;
    for (std::size_t i = 0; i < args.size(); ++i) {
        if (args[i] == "--dry-run") cfg.dryRun = true;
        else if (args[i] == "--debug") cfg.debug = true;
        else if (args[i] == "--window-id" && i + 1 < args.size()) windowId = std::stoul(args[++i]);
        else if (args[i] == "--max-steps" && i + 1 < args.size()) cfg.maxSteps = std::stoi(args[++i]);
        else if (args[i] == "--prompt" && i + 1 < args.size()) userPrompt = args[++i];
    }

    platform::WindowInfo window;
    if (!cfg.dryRun) {
#ifdef __APPLE__
        // Permissions first — fail loudly instead of producing nonsense.
        if (!platform::hasScreenRecordingPermission()) {
            std::printf("[cadgod] Requesting Screen Recording permission…\n");
            if (!platform::requestScreenRecordingPermission()) {
                std::fprintf(stderr,
                             "error: Screen Recording permission denied. Grant it to your "
                             "terminal in System Settings → Privacy & Security → Screen "
                             "Recording, then re-run.\n");
                return 1;
            }
        }
        if (!platform::hasAccessibilityPermission(true)) {
            std::fprintf(stderr,
                         "warning: Accessibility permission missing — camera control (orbit) "
                         "will not work. Grant it in System Settings → Privacy & Security → "
                         "Accessibility. Continuing with screenshots only.\n");
        }

        if (windowId != 0) {
            auto wm = platform::makeWindowManager();
            bool found = false;
            for (const auto& w : wm->listWindows()) {
                if (w.id == windowId) { window = w; found = true; }
            }
            if (!found) {
                std::fprintf(stderr, "error: window id %u not found (run `cadgod windows`)\n", windowId);
                return 1;
            }
            std::printf("[cadgod] Using window %u: %s — %s\n", window.id, window.app.c_str(),
                        window.title.c_str());
        } else {
            std::string why;
            window = app::resolveTargetWindow(why);
            std::printf("[cadgod] Target: %s (window %u) — %s\n", window.app.c_str(), window.id,
                        why.c_str());
        }
#endif
    }

    SessionEvents events;
    events.onState = [](const std::string& phase, const std::string& detail) {
        std::printf("[%-11s] %s\n", phase.c_str(), detail.c_str());
    };
    events.onScreenshot = [](const std::string& id, const std::string& path, const std::string& view) {
        std::printf("[screenshot ] %s (%s) -> %s\n", id.c_str(), view.c_str(), path.c_str());
    };
    events.onVisionNotes = [](const std::string& id, const std::string& notes) {
        std::printf("[vision     ] %s: %s\n", id.c_str(), notes.c_str());
    };
    events.onLog = [](const std::string& line) { std::printf("[log        ] %s\n", line.c_str()); };
    events.askUser = [](const std::string& question, const std::vector<std::string>& options) {
        std::printf("\n>>> %s\n", question.c_str());
        for (std::size_t i = 0; i < options.size(); ++i) {
            std::printf("  %zu) %s\n", i + 1, options[i].c_str());
        }
        std::printf("Answer (number or free text): ");
        std::string line;
        std::getline(std::cin, line);
        try {
            std::size_t n = std::stoul(line);
            if (n >= 1 && n <= options.size()) return options[n - 1];
        } catch (...) {}
        return line;
    };

    try {
        Report report = app::runInspection(window, cfg, userPrompt, events);
        std::string md = report.toMarkdown();
        std::string outPath = cfg.outDir + "/report.md";
        std::ofstream out(outPath);
        out << md;
        std::printf("\n%s\n", md.c_str());
        std::printf("Report written to %s\n", outPath.c_str());
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "\nINSPECTION ABORTED: %s\n", e.what());
        return 1;
    }
}

}  // namespace

int main(int argc, char** argv) {
    std::vector<std::string> args(argv + 1, argv + argc);
    if (args.empty() || args[0] == "help" || args[0] == "--help") {
        std::printf(
            "cadgod — CAD Inspection Copilot (MVP)\n\n"
            "usage:\n"
            "  cadgod windows                       list windows (CAD/browser flagged)\n"
            "  cadgod smoke                         verify the Claude API key with one tiny call\n"
            "  cadgod inspect [--dry-run] [--window-id N] [--prompt \"...\"] [--debug] [--max-steps N]\n"
            "                                       run the inspection state machine\n");
        return 0;
    }
    if (args[0] == "windows") return cmdWindows();
    if (args[0] == "smoke") return cmdSmoke();
    if (args[0] == "inspect") return cmdInspect({args.begin() + 1, args.end()});
    std::fprintf(stderr, "unknown command '%s' (try `cadgod help`)\n", args[0].c_str());
    return 1;
}

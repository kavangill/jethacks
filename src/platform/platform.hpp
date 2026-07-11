#pragma once
// Platform abstraction: window detection, screenshot capture, cursor control,
// permissions. Pure interfaces so the core/agents/tests never depend on OS
// frameworks.

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace cadgod::platform {

struct WindowInfo {
    std::uint32_t id = 0;  // 0 = "full screen" pseudo-window
    int pid = 0;           // owning process id (for activation)
    std::string app;       // owning application ("Autodesk Fusion 360", "Google Chrome", ...)
    std::string title;     // window title; EMPTY without Screen Recording permission
    int x = 0, y = 0, width = 0, height = 0;
    bool isCad = false;      // matched a known CAD app heuristic
    bool isBrowser = false;  // Chromium/Safari/Firefox — possible Onshape host
};

class WindowManager {
public:
    virtual ~WindowManager() = default;
    virtual std::vector<WindowInfo> listWindows() = 0;     // all normal windows
    virtual std::vector<WindowInfo> listCadWindows() = 0;  // filtered to CAD apps
};

class ScreenCapturer {
public:
    virtual ~ScreenCapturer() = default;
    // Captures the given window (or the full screen when window.id == 0) to a
    // PNG at outPath. Returns false on failure.
    virtual bool capture(const WindowInfo& window, const std::string& outPath) = 0;
};

enum class MouseButton { Left, Middle, Right };

struct Modifiers {
    bool shift = false;
    bool ctrl = false;
    bool alt = false;
    bool cmd = false;
};

class InputController {
public:
    virtual ~InputController() = default;
    virtual void moveTo(int x, int y) = 0;
    // Press at (x1,y1), move in small steps to (x2,y2), release. Used for orbit/pan.
    virtual void drag(int x1, int y1, int x2, int y2, MouseButton button, Modifiers mods) = 0;
    virtual void scroll(int x, int y, int deltaY) = 0;  // zoom at cursor position
};

// Heuristics shared by all backends (implemented in platform_common.cpp).
bool looksLikeCadWindow(const std::string& app, const std::string& title);
bool isBrowserApp(const std::string& app);

#ifdef __APPLE__
std::unique_ptr<WindowManager> makeWindowManager();
std::unique_ptr<ScreenCapturer> makeScreenCapturer();
std::unique_ptr<InputController> makeInputController();

// TCC permissions. Screen Recording is required for window titles AND for
// capturing other apps' windows; Accessibility is required for cursor control.
bool hasScreenRecordingPermission();
bool requestScreenRecordingPermission();          // may show the system prompt
bool hasAccessibilityPermission(bool promptUser); // promptUser -> system dialog

// Brings the app owning `pid` to the foreground so cursor input reaches it.
void activateApp(int pid);

// Pseudo-window covering the main display (id == 0) — screenshot-only
// fallback when no individual window can be attached.
WindowInfo mainScreenWindow();
#endif

}  // namespace cadgod::platform

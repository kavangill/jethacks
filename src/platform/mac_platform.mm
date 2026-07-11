// macOS platform backend: CGWindowList window detection, `screencapture`-based
// window/screen capture, CGEvent cursor control, and TCC permission handling.

#include "platform/platform.hpp"

#import <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace cadgod::platform {

namespace {

std::string cfToString(CFStringRef ref) {
    if (!ref) return "";
    char buf[512];
    if (CFStringGetCString(ref, buf, sizeof buf, kCFStringEncodingUTF8)) return buf;
    return "";
}

class MacWindowManager final : public WindowManager {
public:
    std::vector<WindowInfo> listWindows() override {
        std::vector<WindowInfo> out;
        CFArrayRef windows = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
        if (!windows) return out;
        CFIndex count = CFArrayGetCount(windows);
        for (CFIndex i = 0; i < count; ++i) {
            auto dict = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(windows, i));

            // Only normal application windows (layer 0).
            int layer = -1;
            if (auto layerRef = static_cast<CFNumberRef>(CFDictionaryGetValue(dict, kCGWindowLayer))) {
                CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
            }
            if (layer != 0) continue;

            WindowInfo info;
            if (auto idRef = static_cast<CFNumberRef>(CFDictionaryGetValue(dict, kCGWindowNumber))) {
                int64_t wid = 0;
                CFNumberGetValue(idRef, kCFNumberSInt64Type, &wid);
                info.id = static_cast<std::uint32_t>(wid);
            }
            if (auto pidRef = static_cast<CFNumberRef>(CFDictionaryGetValue(dict, kCGWindowOwnerPID))) {
                CFNumberGetValue(pidRef, kCFNumberIntType, &info.pid);
            }
            info.app = cfToString(static_cast<CFStringRef>(CFDictionaryGetValue(dict, kCGWindowOwnerName)));
            info.title = cfToString(static_cast<CFStringRef>(CFDictionaryGetValue(dict, kCGWindowName)));

            if (auto boundsRef = static_cast<CFDictionaryRef>(CFDictionaryGetValue(dict, kCGWindowBounds))) {
                CGRect rect;
                if (CGRectMakeWithDictionaryRepresentation(boundsRef, &rect)) {
                    info.x = static_cast<int>(rect.origin.x);
                    info.y = static_cast<int>(rect.origin.y);
                    info.width = static_cast<int>(rect.size.width);
                    info.height = static_cast<int>(rect.size.height);
                }
            }
            if (info.width < 300 || info.height < 200) continue;  // skip tool palettes
            info.isCad = looksLikeCadWindow(info.app, info.title);
            info.isBrowser = isBrowserApp(info.app);
            out.push_back(info);
        }
        CFRelease(windows);
        return out;
    }

    std::vector<WindowInfo> listCadWindows() override {
        std::vector<WindowInfo> out;
        for (auto& w : listWindows()) {
            if (w.isCad) out.push_back(w);
        }
        return out;
    }
};

class MacScreenCapturer final : public ScreenCapturer {
public:
    bool capture(const WindowInfo& window, const std::string& outPath) override {
        // `screencapture -l` captures a single window by id even when it is
        // not frontmost; -x mutes the sound, -o omits the shadow. id == 0
        // means capture the entire main screen.
        std::string cmd;
        if (window.id == 0) {
            cmd = "/usr/sbin/screencapture -x '" + outPath + "' 2>/dev/null";
        } else {
            cmd = "/usr/sbin/screencapture -x -o -l " + std::to_string(window.id) + " '" +
                  outPath + "' 2>/dev/null";
        }
        if (std::system(cmd.c_str()) != 0) return false;
        struct stat st{};
        if (::stat(outPath.c_str(), &st) != 0 || st.st_size == 0) return false;

        // Cap the long edge at 1568 px. Claude downsamples vision inputs past
        // ~1568 px anyway, so a full retina capture (3000+ px wide) only wastes
        // image tokens with no quality gain. `sips` ships with macOS; if it
        // fails we still return the full-size screenshot rather than erroring.
        std::string resize = "/usr/bin/sips -Z 1568 '" + outPath + "' >/dev/null 2>&1";
        std::system(resize.c_str());
        return true;
    }
};

class MacInputController final : public InputController {
public:
    void moveTo(int x, int y) override {
        postMouse(kCGEventMouseMoved, kCGMouseButtonLeft, x, y, 0);
    }

    void drag(int x1, int y1, int x2, int y2, MouseButton button, Modifiers mods) override {
        CGEventType down, dragType, up;
        CGMouseButton cgButton;
        buttonEvents(button, down, dragType, up, cgButton);
        CGEventFlags flags = toFlags(mods);

        postMouse(kCGEventMouseMoved, cgButton, x1, y1, flags);
        usleep(60000);
        postMouse(down, cgButton, x1, y1, flags);
        usleep(60000);
        const int steps = 12;
        for (int i = 1; i <= steps; ++i) {
            int px = x1 + (x2 - x1) * i / steps;
            int py = y1 + (y2 - y1) * i / steps;
            postMouse(dragType, cgButton, px, py, flags);
            usleep(15000);
        }
        postMouse(up, cgButton, x2, y2, flags);
        usleep(150000);  // let the CAD app settle before the screenshot
    }

    void scroll(int x, int y, int deltaY) override {
        moveTo(x, y);
        usleep(30000);
        CGEventRef ev = CGEventCreateScrollWheelEvent(nullptr, kCGScrollEventUnitLine, 1, deltaY);
        CGEventPost(kCGHIDEventTap, ev);
        CFRelease(ev);
        usleep(120000);
    }

private:
    static void buttonEvents(MouseButton b, CGEventType& down, CGEventType& drag, CGEventType& up,
                             CGMouseButton& cgButton) {
        switch (b) {
            case MouseButton::Left:
                down = kCGEventLeftMouseDown; drag = kCGEventLeftMouseDragged;
                up = kCGEventLeftMouseUp; cgButton = kCGMouseButtonLeft;
                break;
            case MouseButton::Right:
                down = kCGEventRightMouseDown; drag = kCGEventRightMouseDragged;
                up = kCGEventRightMouseUp; cgButton = kCGMouseButtonRight;
                break;
            case MouseButton::Middle:
            default:
                down = kCGEventOtherMouseDown; drag = kCGEventOtherMouseDragged;
                up = kCGEventOtherMouseUp; cgButton = kCGMouseButtonCenter;
                break;
        }
    }

    static CGEventFlags toFlags(Modifiers m) {
        CGEventFlags f = 0;
        if (m.shift) f |= kCGEventFlagMaskShift;
        if (m.ctrl) f |= kCGEventFlagMaskControl;
        if (m.alt) f |= kCGEventFlagMaskAlternate;
        if (m.cmd) f |= kCGEventFlagMaskCommand;
        return f;
    }

    static void postMouse(CGEventType type, CGMouseButton button, int x, int y, CGEventFlags flags) {
        CGEventRef ev = CGEventCreateMouseEvent(nullptr, type,
                                                CGPointMake(static_cast<CGFloat>(x), static_cast<CGFloat>(y)),
                                                button);
        if (flags) CGEventSetFlags(ev, flags);
        CGEventPost(kCGHIDEventTap, ev);
        CFRelease(ev);
    }
};

}  // namespace

std::unique_ptr<WindowManager> makeWindowManager() { return std::make_unique<MacWindowManager>(); }
std::unique_ptr<ScreenCapturer> makeScreenCapturer() { return std::make_unique<MacScreenCapturer>(); }
std::unique_ptr<InputController> makeInputController() { return std::make_unique<MacInputController>(); }

bool hasScreenRecordingPermission() { return CGPreflightScreenCaptureAccess(); }

bool requestScreenRecordingPermission() { return CGRequestScreenCaptureAccess(); }

bool hasAccessibilityPermission(bool promptUser) {
    NSDictionary* opts =
        @{(__bridge NSString*)kAXTrustedCheckOptionPrompt : promptUser ? @YES : @NO};
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
}

void activateApp(int pid) {
    if (pid <= 0) return;
    NSRunningApplication* app =
        [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    [app activateWithOptions:NSApplicationActivateAllWindows];
}

WindowInfo mainScreenWindow() {
    CGRect b = CGDisplayBounds(CGMainDisplayID());
    WindowInfo w;
    w.id = 0;
    w.pid = 0;
    w.app = "Full screen";
    w.title = "entire main display";
    w.x = static_cast<int>(b.origin.x);
    w.y = static_cast<int>(b.origin.y);
    w.width = static_cast<int>(b.size.width);
    w.height = static_cast<int>(b.size.height);
    return w;
}

}  // namespace cadgod::platform

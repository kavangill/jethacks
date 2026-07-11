#include "platform/platform.hpp"

#include <algorithm>

namespace cadgod::platform {

namespace {

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), ::tolower);
    return s;
}

bool contains(const std::string& haystack, const char* needle) {
    return haystack.find(needle) != std::string::npos;
}

}  // namespace

bool isBrowserApp(const std::string& app) {
    std::string a = lower(app);
    return contains(a, "chrome") || contains(a, "safari") || contains(a, "edge") ||
           contains(a, "firefox") || contains(a, "arc") || contains(a, "brave") ||
           contains(a, "chromium") || contains(a, "opera");
}

bool looksLikeCadWindow(const std::string& app, const std::string& title) {
    std::string a = lower(app);
    std::string t = lower(title);
    if (contains(a, "fusion")) return true;      // Autodesk Fusion 360
    if (contains(a, "solidworks")) return true;  // SolidWorks
    if (contains(a, "onshape")) return true;     // Onshape desktop wrapper
    // Onshape runs in a browser: match by tab/window title. NOTE: titles are
    // empty without Screen Recording permission — callers must fall back to
    // screenshot-based verification for browser windows.
    if (isBrowserApp(a) && contains(t, "onshape")) return true;
    return false;
}

}  // namespace cadgod::platform

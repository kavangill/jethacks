#include "core/screenshot_store.hpp"

#include <fstream>
#include <sstream>
#include <stdexcept>

namespace cadgod {

std::uint64_t ScreenshotStore::fnv1a(const std::string& bytes) {
    std::uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : bytes) {
        h ^= c;
        h *= 1099511628211ULL;
    }
    return h;
}

ScreenshotStore::AddResult ScreenshotStore::addFile(const std::string& path, const std::string& viewName) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("ScreenshotStore: cannot read " + path);
    std::ostringstream ss;
    ss << f.rdbuf();
    return addBytes(ss.str(), path, viewName);
}

ScreenshotStore::AddResult ScreenshotStore::addBytes(const std::string& bytes, const std::string& path,
                                                     const std::string& viewName) {
    std::uint64_t h = fnv1a(bytes);
    for (const auto& s : shots_) {
        if (s.hash == h) return {s.id, true};
    }
    Screenshot shot;
    shot.id = "shot-" + std::to_string(shots_.size() + 1);
    shot.path = path;
    shot.viewName = viewName;
    shot.hash = h;
    shots_.push_back(shot);
    return {shot.id, false};
}

const Screenshot* ScreenshotStore::get(const std::string& id) const {
    for (const auto& s : shots_) {
        if (s.id == id) return &s;
    }
    return nullptr;
}

bool ScreenshotStore::wasSent(const std::string& id) const {
    const Screenshot* s = get(id);
    return s && s->sentToApi;
}

void ScreenshotStore::markSent(const std::string& id) {
    for (auto& s : shots_) {
        if (s.id == id) s.sentToApi = true;
    }
}

}  // namespace cadgod

#pragma once
// Screenshot evidence store with content-hash deduplication. Identical frames
// are never stored (or sent to the API) twice — a core cost control.

#include <cstdint>
#include <string>
#include <vector>

namespace cadgod {

struct Screenshot {
    std::string id;        // "shot-1", "shot-2", ...
    std::string path;      // file on disk
    std::string viewName;  // planner view label
    std::uint64_t hash = 0;
    bool sentToApi = false;
};

class ScreenshotStore {
public:
    struct AddResult {
        std::string id;
        bool duplicate = false;  // true -> id refers to the earlier identical shot
    };

    AddResult addFile(const std::string& path, const std::string& viewName);  // throws if unreadable
    AddResult addBytes(const std::string& bytes, const std::string& path, const std::string& viewName);

    const Screenshot* get(const std::string& id) const;
    bool wasSent(const std::string& id) const;
    void markSent(const std::string& id);

    std::size_t size() const { return shots_.size(); }
    const std::vector<Screenshot>& all() const { return shots_; }

    static std::uint64_t fnv1a(const std::string& bytes);

private:
    std::vector<Screenshot> shots_;
};

}  // namespace cadgod

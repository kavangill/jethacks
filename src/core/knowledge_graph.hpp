#pragma once
// Persistent structured memory of the CAD model under inspection. Objects are
// merged by id so the system never "rediscovers" a component it has already
// seen — repeated sightings only add evidence.

#include <map>
#include <string>
#include <vector>

#include "core/json.hpp"

namespace cadgod {

struct GraphObject {
    std::string id;    // e.g. "motor_1"
    std::string type;  // e.g. "motor", "shaft", "bracket"
    double confidence = 0.0;
    std::vector<std::string> features;         // observed geometry features
    std::vector<std::string> screenshots;      // screenshot ids this was seen in
    std::vector<std::string> featureTreeRefs;  // feature tree entries, if any
};

struct Relationship {
    std::string from;
    std::string kind;  // "connected_to", "constrained_by", ...
    std::string to;
    bool operator==(const Relationship& o) const {
        return from == o.from && kind == o.kind && to == o.to;
    }
};

class KnowledgeGraph {
public:
    // Merge by id: keeps max confidence, unions features/screenshots/tree refs.
    void upsert(const GraphObject& obj);
    void relate(const std::string& from, const std::string& kind, const std::string& to);

    const GraphObject* find(const std::string& id) const;
    std::vector<const GraphObject*> byType(const std::string& type) const;

    std::size_t objectCount() const { return objects_.size(); }
    std::size_t relationshipCount() const { return relationships_.size(); }
    double overallConfidence() const;  // mean object confidence; 0 when empty

    const std::map<std::string, GraphObject>& objects() const { return objects_; }
    const std::vector<Relationship>& relationships() const { return relationships_; }

    // Feature tree entries observed in the CAD UI (deduplicated).
    void addFeatureTree(const std::vector<std::string>& entries);
    const std::vector<std::string>& featureTree() const { return featureTree_; }

    Json toJson() const;
    std::string summary() const;  // compact text form for prompts

private:
    std::map<std::string, GraphObject> objects_;
    std::vector<Relationship> relationships_;
    std::vector<std::string> featureTree_;
};

}  // namespace cadgod

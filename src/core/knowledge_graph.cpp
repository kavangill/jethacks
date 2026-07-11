#include "core/knowledge_graph.hpp"

#include <algorithm>

namespace cadgod {

namespace {

void unionInto(std::vector<std::string>& dst, const std::vector<std::string>& src) {
    for (const auto& s : src) {
        if (std::find(dst.begin(), dst.end(), s) == dst.end()) dst.push_back(s);
    }
}

}  // namespace

void KnowledgeGraph::upsert(const GraphObject& obj) {
    if (obj.id.empty()) return;
    auto it = objects_.find(obj.id);
    if (it == objects_.end()) {
        objects_[obj.id] = obj;
        return;
    }
    GraphObject& existing = it->second;
    if (existing.type.empty()) existing.type = obj.type;
    existing.confidence = std::max(existing.confidence, obj.confidence);
    unionInto(existing.features, obj.features);
    unionInto(existing.screenshots, obj.screenshots);
    unionInto(existing.featureTreeRefs, obj.featureTreeRefs);
}

void KnowledgeGraph::relate(const std::string& from, const std::string& kind, const std::string& to) {
    if (from.empty() || to.empty() || from == to) return;
    Relationship r{from, kind, to};
    if (std::find(relationships_.begin(), relationships_.end(), r) == relationships_.end()) {
        relationships_.push_back(r);
    }
}

const GraphObject* KnowledgeGraph::find(const std::string& id) const {
    auto it = objects_.find(id);
    return it == objects_.end() ? nullptr : &it->second;
}

std::vector<const GraphObject*> KnowledgeGraph::byType(const std::string& type) const {
    std::vector<const GraphObject*> out;
    for (const auto& [_, obj] : objects_) {
        if (obj.type == type) out.push_back(&obj);
    }
    return out;
}

void KnowledgeGraph::addFeatureTree(const std::vector<std::string>& entries) {
    unionInto(featureTree_, entries);
}

double KnowledgeGraph::overallConfidence() const {
    if (objects_.empty()) return 0.0;
    double sum = 0.0;
    for (const auto& [_, obj] : objects_) sum += obj.confidence;
    return sum / static_cast<double>(objects_.size());
}

Json KnowledgeGraph::toJson() const {
    Json objs = Json::array();
    for (const auto& [_, o] : objects_) {
        Json j = Json::object();
        j["id"] = o.id;
        j["type"] = o.type;
        j["confidence"] = o.confidence;
        Json feats = Json::array();
        for (const auto& f : o.features) feats.push_back(f);
        j["features"] = feats;
        Json shots = Json::array();
        for (const auto& s : o.screenshots) shots.push_back(s);
        j["screenshots"] = shots;
        objs.push_back(j);
    }
    Json rels = Json::array();
    for (const auto& r : relationships_) {
        Json j = Json::object();
        j["from"] = r.from;
        j["kind"] = r.kind;
        j["to"] = r.to;
        rels.push_back(j);
    }
    Json root = Json::object();
    root["objects"] = objs;
    root["relationships"] = rels;
    return root;
}

std::string KnowledgeGraph::summary() const {
    std::string out;
    for (const auto& [_, o] : objects_) {
        out += "- " + o.id + " (" + o.type + ", confidence " +
               std::to_string(o.confidence).substr(0, 4) + ")";
        if (!o.features.empty()) {
            out += " features: ";
            for (std::size_t i = 0; i < o.features.size(); ++i) {
                if (i) out += ", ";
                out += o.features[i];
            }
        }
        if (!o.screenshots.empty()) {
            out += " [seen in: ";
            for (std::size_t i = 0; i < o.screenshots.size(); ++i) {
                if (i) out += ", ";
                out += o.screenshots[i];
            }
            out += "]";
        }
        out += "\n";
    }
    for (const auto& r : relationships_) {
        out += "- " + r.from + " --" + r.kind + "--> " + r.to + "\n";
    }
    if (!featureTree_.empty()) {
        out += "Feature tree entries observed: ";
        for (std::size_t i = 0; i < featureTree_.size(); ++i) {
            if (i) out += ", ";
            out += featureTree_[i];
        }
        out += "\n";
    }
    if (out.empty()) out = "(no objects observed yet)\n";
    return out;
}

}  // namespace cadgod

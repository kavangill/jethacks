// CADGOD test suite — tiny self-contained framework, no dependencies.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <vector>

#include "core/agents.hpp"
#include "core/claude_client.hpp"
#include "core/env.hpp"
#include "core/json.hpp"
#include "core/knowledge_graph.hpp"
#include "core/screenshot_store.hpp"
#include "core/session.hpp"
#include "platform/platform.hpp"

using namespace cadgod;

// ------------------------------------------------------------ framework ----

namespace {

int g_failures = 0;
int g_checks = 0;
std::string g_currentTest;

#define CHECK(cond)                                                                       \
    do {                                                                                  \
        ++g_checks;                                                                       \
        if (!(cond)) {                                                                    \
            ++g_failures;                                                                 \
            std::printf("  FAIL %s:%d in %s: %s\n", __FILE__, __LINE__,                   \
                        g_currentTest.c_str(), #cond);                                    \
        }                                                                                 \
    } while (0)

#define CHECK_EQ(a, b)                                                                    \
    do {                                                                                  \
        ++g_checks;                                                                       \
        auto va = (a);                                                                    \
        auto vb = (b);                                                                    \
        if (!(va == vb)) {                                                                \
            ++g_failures;                                                                 \
            std::printf("  FAIL %s:%d in %s: %s == %s\n", __FILE__, __LINE__,             \
                        g_currentTest.c_str(), #a, #b);                                   \
        }                                                                                 \
    } while (0)

#define CHECK_THROWS(expr)                                                                \
    do {                                                                                  \
        ++g_checks;                                                                       \
        bool threw = false;                                                               \
        try {                                                                             \
            (void)(expr);                                                                 \
        } catch (const std::exception&) {                                                 \
            threw = true;                                                                 \
        }                                                                                 \
        if (!threw) {                                                                     \
            ++g_failures;                                                                 \
            std::printf("  FAIL %s:%d in %s: expected throw: %s\n", __FILE__, __LINE__,   \
                        g_currentTest.c_str(), #expr);                                    \
        }                                                                                 \
    } while (0)

struct Test {
    const char* name;
    std::function<void()> fn;
};
std::vector<Test>& registry() {
    static std::vector<Test> tests;
    return tests;
}
struct Register {
    Register(const char* name, std::function<void()> fn) { registry().push_back({name, fn}); }
};
#define TEST(name)                                                       \
    void test_##name();                                                  \
    Register reg_##name(#name, test_##name);                             \
    void test_##name()

const std::string kTmpDir = "build/test-tmp";

std::string writeTmp(const std::string& name, const std::string& content) {
    std::filesystem::create_directories(kTmpDir);
    std::string path = kTmpDir + "/" + name;
    std::ofstream f(path, std::ios::binary);
    f << content;
    return path;
}

// ----------------------------------------------------------------- mocks ---

class MockTransport final : public HttpTransport {
public:
    struct Recorded {
        std::string url;
        std::vector<std::string> headers;
        std::string body;
    };
    std::vector<Recorded> requests;
    std::vector<HttpResponse> queue;

    HttpResponse post(const std::string& url, const std::vector<std::string>& headers,
                      const std::string& body) override {
        requests.push_back({url, headers, body});
        if (queue.empty()) return {500, R"({"error":{"type":"test","message":"queue empty"}})", ""};
        HttpResponse r = queue.front();
        queue.erase(queue.begin());
        return r;
    }
};

HttpResponse okResponse(const std::string& text, const char* stopReason = "end_turn") {
    Json content = Json::array();
    Json block = Json::object();
    block["type"] = "text";
    block["text"] = text;
    content.push_back(block);
    Json usage = Json::object();
    usage["input_tokens"] = 120;
    usage["output_tokens"] = 45;
    Json body = Json::object();
    body["content"] = content;
    body["stop_reason"] = stopReason;
    body["usage"] = usage;
    return {200, body.dump(), ""};
}

bool headerPresent(const std::vector<std::string>& headers, const std::string& value) {
    for (const auto& h : headers) {
        if (h == value) return true;
    }
    return false;
}

// Fake camera: distinct file per view; "top" repeats the bytes of "front" to
// exercise the dedup-skips-vision path.
class FakeCamera final : public ICamera {
public:
    std::vector<std::string> captured;
    bool failNext = false;
    std::string captureView(const std::string& viewName) override {
        if (failNext) {
            failNext = false;
            throw std::runtime_error("simulated capture failure");
        }
        captured.push_back(viewName);
        std::string content = (viewName == "top") ? "bytes-front" : "bytes-" + viewName;
        return writeTmp("cam_" + std::to_string(captured.size()) + ".png", content);
    }
};

class FakeVision final : public IVision {
public:
    int extractCalls = 0;
    int classifyCalls = 0;
    bool isCad = true;
    std::string modelType = "mechanical_assembly";
    double confidence = 0.9;
    std::vector<std::string> contexts;

    VisionFacts extract(const std::string&, const std::string& viewName,
                        const std::string& context, const KnowledgeGraph&, bool classify) override {
        ++extractCalls;
        if (classify) ++classifyCalls;
        contexts.push_back(context);
        VisionFacts f;
        f.isCadViewport = isCad;
        if (classify) {
            f.application = "Onshape";
            f.modelType = modelType;
            f.purpose = "test purpose";
        }
        if (!isCad) return f;  // non-CAD frame -> no objects
        GraphObject o;
        o.id = "obj_" + viewName;
        o.type = "bracket";
        o.confidence = confidence;
        f.objects.push_back(o);
        if (viewName == "front") f.featureTree = {"Sketch1", "Extrude1"};
        return f;
    }
};

class FakeResearch final : public IResearch {
public:
    std::vector<Evidence> research(const KnowledgeGraph&) override {
        return {{"topic", "summary", "source"}};
    }
};

class FakeEngineering final : public IEngineering {
public:
    int calls = 0;         // report() calls
    int questionCalls = 0; // clarifyingQuestions() calls
    std::string lastContext;
    std::vector<std::string> probeQuestions;  // returned by clarifyingQuestions()

    std::vector<std::string> clarifyingQuestions(const KnowledgeGraph&,
                                                 const std::vector<Evidence>&,
                                                 const std::string&) override {
        ++questionCalls;
        return probeQuestions;
    }
    Report report(const KnowledgeGraph& kg, const std::vector<Evidence>&, const ScreenshotStore&,
                  const std::string& context) override {
        ++calls;
        lastContext = context;
        Report r;
        Issue i;
        i.title = "test issue";
        i.description = "kg has " + std::to_string(kg.objectCount()) + " objects";
        i.severity = "low";
        i.confidence = 0.5;
        r.issues.push_back(i);
        return r;
    }
};

struct SessionHarness {
    FakeCamera camera;
    FakeVision vision;
    FakeResearch research;
    FakeEngineering engineering;
    ScreenshotStore store;
    KnowledgeGraph kg;
    std::vector<std::string> phases;
    std::vector<std::string> shots;
    std::vector<std::string> notes;
    std::vector<std::string> questions;
    std::string cannedAnswer = "Robot";

    InspectionSession make(SessionConfig cfg) {
        SessionEvents events;
        events.onState = [this](const std::string& p, const std::string&) { phases.push_back(p); };
        events.onScreenshot = [this](const std::string& id, const std::string&, const std::string&) {
            shots.push_back(id);
        };
        events.onVisionNotes = [this](const std::string&, const std::string& n) {
            notes.push_back(n);
        };
        events.askUser = [this](const std::string& q, const std::vector<std::string>&) {
            questions.push_back(q);
            return cannedAnswer;
        };
        return InspectionSession(cfg, &camera, &vision, &research, &engineering, &store, &kg,
                                 events);
    }
};

bool phaseBefore(const std::vector<std::string>& phases, const std::string& a,
                 const std::string& b) {
    std::size_t ia = phases.size(), ib = phases.size();
    for (std::size_t i = 0; i < phases.size(); ++i) {
        if (phases[i] == a && ia == phases.size()) ia = i;
        if (phases[i] == b && ib == phases.size()) ib = i;
    }
    return ia < ib;
}

// ----------------------------------------------------------------- tests ---

TEST(json_parse_roundtrip) {
    Json v = Json::parse(R"({"a":1,"b":[true,null,"x"],"c":{"d":-2.5},"e":"q\"\n\t"})");
    CHECK(v.isObject());
    CHECK_EQ(v.at("a").asNumber(), 1.0);
    CHECK(v.at("b").isArray());
    CHECK_EQ(v.at("b").size(), std::size_t{3});
    CHECK_EQ(v.at("b")[0].asBool(), true);
    CHECK(v.at("b")[1].isNull());
    CHECK_EQ(v.at("b")[2].asString(), "x");
    CHECK_EQ(v.at("c").at("d").asNumber(), -2.5);
    CHECK_EQ(v.at("e").asString(), "q\"\n\t");

    std::string d1 = v.dump();
    std::string d2 = Json::parse(d1).dump();
    CHECK_EQ(d1, d2);
    CHECK_EQ(Json(16000).dump(), "16000");
}

TEST(json_unicode_and_errors) {
    Json v = Json::parse(R"({"s":"café 😀"})");
    CHECK_EQ(v.at("s").asString(), "café 😀");
    CHECK_THROWS(Json::parse("{bad"));
    CHECK_THROWS(Json::parse(R"({"a":1} trailing)"));
    CHECK_THROWS(Json::parse(""));
    CHECK_THROWS(Json().asString());
}

TEST(env_file_parsing) {
    std::string path = writeTmp("test.env",
                                "# comment\n"
                                "ANTHROPIC_API_KEY=sk-test-123\n"
                                "export QUOTED=\"hello world\"\n"
                                "SINGLE='v'\n"
                                "  SPACED  =  padded  \n"
                                "IGNORED_LINE\n");
    auto env = loadEnvFile(path);
    CHECK_EQ(env["ANTHROPIC_API_KEY"], "sk-test-123");
    CHECK_EQ(env["QUOTED"], "hello world");
    CHECK_EQ(env["SINGLE"], "v");
    CHECK_EQ(env["SPACED"], "padded");
    CHECK_EQ(env.count("IGNORED_LINE"), std::size_t{0});

    setenv("CADGOD_TEST_KEY", "from-process", 1);
    std::map<std::string, std::string> fileEnv{{"CADGOD_TEST_KEY", "from-file"}};
    CHECK_EQ(configValue("CADGOD_TEST_KEY", fileEnv), "from-process");
    unsetenv("CADGOD_TEST_KEY");
    CHECK_EQ(configValue("CADGOD_TEST_KEY", fileEnv), "from-file");
    CHECK_EQ(configValue("CADGOD_MISSING", fileEnv, "fallback"), "fallback");
    CHECK(loadEnvFile("does/not/exist.env").empty());
}

TEST(screenshot_dedup) {
    ScreenshotStore store;
    auto a = store.addBytes("image-bytes-1", "a.png", "front");
    CHECK(!a.duplicate);
    CHECK_EQ(a.id, "shot-1");

    auto b = store.addBytes("image-bytes-2", "b.png", "top");
    CHECK(!b.duplicate);
    CHECK_EQ(b.id, "shot-2");

    auto c = store.addBytes("image-bytes-1", "c.png", "back");
    CHECK(c.duplicate);
    CHECK_EQ(c.id, "shot-1");
    CHECK_EQ(store.size(), std::size_t{2});

    CHECK(!store.wasSent("shot-1"));
    store.markSent("shot-1");
    CHECK(store.wasSent("shot-1"));

    std::string path = writeTmp("shot.png", "file-bytes");
    auto d = store.addFile(path, "iso");
    CHECK(!d.duplicate);
    CHECK_THROWS(store.addFile("missing/file.png", "iso"));
}

TEST(knowledge_graph_merge) {
    KnowledgeGraph kg;
    GraphObject motor;
    motor.id = "motor_1";
    motor.type = "motor";
    motor.confidence = 0.6;
    motor.features = {"NEMA17"};
    motor.screenshots = {"shot-1"};
    kg.upsert(motor);

    GraphObject again;
    again.id = "motor_1";
    again.type = "motor";
    again.confidence = 0.9;
    again.features = {"NEMA17", "4 mounting holes"};
    again.screenshots = {"shot-2"};
    kg.upsert(again);

    CHECK_EQ(kg.objectCount(), std::size_t{1});
    const GraphObject* m = kg.find("motor_1");
    CHECK(m != nullptr);
    CHECK_EQ(m->confidence, 0.9);
    CHECK_EQ(m->features.size(), std::size_t{2});
    CHECK_EQ(m->screenshots.size(), std::size_t{2});

    kg.relate("motor_1", "connected_to", "bracket_1");
    kg.relate("motor_1", "connected_to", "bracket_1");
    kg.relate("motor_1", "connected_to", "motor_1");
    CHECK_EQ(kg.relationshipCount(), std::size_t{1});

    kg.addFeatureTree({"Sketch1", "Extrude1"});
    kg.addFeatureTree({"Extrude1", "Fillet1"});
    CHECK_EQ(kg.featureTree().size(), std::size_t{3});
    CHECK(kg.summary().find("Fillet1") != std::string::npos);

    GraphObject bracket;
    bracket.id = "bracket_1";
    bracket.type = "bracket";
    bracket.confidence = 0.5;
    kg.upsert(bracket);
    CHECK(std::fabs(kg.overallConfidence() - 0.7) < 1e-9);
    CHECK_EQ(kg.byType("motor").size(), std::size_t{1});

    Json j = kg.toJson();
    CHECK_EQ(j.at("objects").size(), std::size_t{2});
    CHECK_EQ(j.at("relationships").size(), std::size_t{1});
}

TEST(planner_behavior) {
    PlannerAgent planner(0.75, 6, 3);
    KnowledgeGraph kg;

    PlanAction a = planner.next(kg, 0);
    CHECK(a.type == PlanAction::Type::CaptureView);
    CHECK_EQ(a.viewName, "isometric");

    GraphObject o;
    o.id = "x";
    o.type = "plate";
    o.confidence = 0.3;
    kg.upsert(o);
    CHECK(planner.next(kg, 2).type == PlanAction::Type::CaptureView);

    GraphObject o2;
    o2.id = "x";
    o2.confidence = 0.95;
    kg.upsert(o2);
    CHECK(planner.next(kg, 3).type == PlanAction::Type::Complete);
    CHECK(planner.next(kg, 2).type == PlanAction::Type::CaptureView);

    KnowledgeGraph empty;
    CHECK(planner.next(empty, 6).type == PlanAction::Type::Complete);
}

TEST(claude_client_request_format) {
    MockTransport transport;
    transport.queue.push_back(okResponse("CADGOD OK"));
    ClaudeClient client("sk-test-key", "claude-opus-4-8", &transport);

    Json content = Json::array();
    content.push_back(ClaudeClient::textBlock("hello"));
    content.push_back(ClaudeClient::imageBlock("image/png", "aW1n"));
    Json messages = Json::array();
    messages.push_back(ClaudeClient::userMessage(content));

    ClaudeOptions opts;
    opts.maxTokens = 555;
    opts.adaptiveThinking = true;
    ClaudeResult r = client.complete("be brief", messages, opts);

    CHECK(r.ok);
    CHECK_EQ(r.text, "CADGOD OK");
    CHECK_EQ(r.stopReason, "end_turn");
    CHECK_EQ(r.inputTokens, 120L);
    CHECK_EQ(r.outputTokens, 45L);

    CHECK_EQ(transport.requests.size(), std::size_t{1});
    const auto& req = transport.requests[0];
    CHECK_EQ(req.url, std::string(ClaudeClient::kApiUrl));
    CHECK(headerPresent(req.headers, "x-api-key: sk-test-key"));
    CHECK(headerPresent(req.headers, "anthropic-version: 2023-06-01"));
    CHECK(headerPresent(req.headers, "content-type: application/json"));

    Json body = Json::parse(req.body);
    CHECK_EQ(body.getString("model"), "claude-opus-4-8");
    CHECK_EQ(body.getNumber("max_tokens"), 555.0);
    CHECK_EQ(body.getString("system"), "be brief");
    CHECK_EQ(body.at("thinking").getString("type"), "adaptive");
    CHECK_EQ(body.at("messages").size(), std::size_t{1});
    const Json& msg = body.at("messages")[0];
    CHECK_EQ(msg.getString("role"), "user");
    CHECK_EQ(msg.at("content")[0].getString("type"), "text");
    const Json& img = msg.at("content")[1];
    CHECK_EQ(img.getString("type"), "image");
    CHECK_EQ(img.at("source").getString("type"), "base64");
    CHECK_EQ(img.at("source").getString("media_type"), "image/png");
    CHECK_EQ(img.at("source").getString("data"), "aW1n");
}

TEST(claude_client_errors) {
    MockTransport transport;
    transport.queue.push_back(
        {401, R"({"type":"error","error":{"type":"authentication_error","message":"bad key"}})", ""});
    ClaudeClient client("bad", "m", &transport);
    Json messages = Json::array();
    Json content = Json::array();
    content.push_back(ClaudeClient::textBlock("hi"));
    messages.push_back(ClaudeClient::userMessage(content));

    ClaudeResult r = client.complete("", messages, {});
    CHECK(!r.ok);
    CHECK(r.error.find("401") != std::string::npos);
    CHECK(r.error.find("bad key") != std::string::npos);

    transport.queue.push_back(okResponse("", "refusal"));
    ClaudeResult r2 = client.complete("", messages, {});
    CHECK(!r2.ok);
    CHECK(r2.error.find("refusal") != std::string::npos);

    transport.queue.push_back({0, "", "could not connect"});
    ClaudeResult r3 = client.complete("", messages, {});
    CHECK(!r3.ok);
    CHECK(r3.error.find("could not connect") != std::string::npos);
}

TEST(claude_client_output_schema) {
    MockTransport transport;
    transport.queue.push_back(okResponse(R"({"objects":[],"notes":"n"})"));
    ClaudeClient client("k", "m", &transport);
    Json messages = Json::array();
    Json content = Json::array();
    content.push_back(ClaudeClient::textBlock("x"));
    messages.push_back(ClaudeClient::userMessage(content));

    ClaudeOptions opts;
    opts.outputSchema = VisionAgent::outputSchema(/*classify=*/false);
    client.complete("", messages, opts);

    Json body = Json::parse(transport.requests[0].body);
    const Json& fmt = body.at("output_config").at("format");
    CHECK_EQ(fmt.getString("type"), "json_schema");
    CHECK_EQ(fmt.at("schema").getString("type"), "object");
    CHECK(fmt.at("schema").at("properties").contains("objects"));
    CHECK(fmt.at("schema").at("properties").contains("is_cad_viewport"));
    CHECK(fmt.at("schema").at("properties").contains("feature_tree"));
    // Non-classify schema omits the model-classification fields.
    CHECK(!fmt.at("schema").at("properties").contains("model_type"));
    // Classify schema (first frame) adds them.
    CHECK(VisionAgent::outputSchema(true).at("properties").contains("model_type"));
    CHECK(VisionAgent::outputSchema(true).at("properties").contains("purpose"));
}

TEST(base64_encoding) {
    CHECK_EQ(ClaudeClient::base64Encode(""), "");
    CHECK_EQ(ClaudeClient::base64Encode("M"), "TQ==");
    CHECK_EQ(ClaudeClient::base64Encode("Ma"), "TWE=");
    CHECK_EQ(ClaudeClient::base64Encode("Man"), "TWFu");
    CHECK_EQ(ClaudeClient::base64Encode("light work."), "bGlnaHQgd29yay4=");
    CHECK_EQ(ClaudeClient::mediaTypeForPath("a/b/shot.PNG"), "image/png");
    CHECK_EQ(ClaudeClient::mediaTypeForPath("x.jpeg"), "image/jpeg");
}

TEST(vision_agent_extract) {
    MockTransport transport;
    transport.queue.push_back(okResponse(
        R"({"is_cad_viewport":true,"objects":[{"id":"bracket_1","type":"bracket","confidence":0.9,)"
        R"("features":["L-shaped"],"connected_to":["plate_1"]}],)"
        R"("feature_tree":["Sketch1","Extrude1"],"notes":"clear view"})"));
    ClaudeClient client("k", "m", &transport);
    VisionAgent vision(&client);

    std::string img = writeTmp("vision.png", "fake-png-bytes");
    KnowledgeGraph known;
    VisionFacts facts = vision.extract(img, "front", "User description: gearbox", known,
                                       /*classify=*/false);

    CHECK(facts.isCadViewport);
    CHECK_EQ(facts.objects.size(), std::size_t{1});
    CHECK_EQ(facts.objects[0].id, "bracket_1");
    CHECK_EQ(facts.objects[0].confidence, 0.9);
    CHECK_EQ(facts.relationships.size(), std::size_t{1});
    CHECK_EQ(facts.featureTree.size(), std::size_t{2});
    CHECK_EQ(facts.notes, "clear view");

    Json body = Json::parse(transport.requests[0].body);
    CHECK(body.getString("system").find("Never assume or invent components") != std::string::npos);
    // Token efficiency: vision extraction runs WITHOUT extended thinking — the
    // model's effort goes into reading the image, not chain-of-thought.
    CHECK(!body.contains("thinking"));
    const Json& blocks = body.at("messages")[0].at("content");
    CHECK_EQ(blocks[0].getString("type"), "image");
    CHECK_EQ(blocks[0].at("source").getString("data"), ClaudeClient::base64Encode("fake-png-bytes"));
    CHECK(blocks[1].getString("text").find("gearbox") != std::string::npos);

    // non-CAD frame -> no objects even if listed
    transport.queue.push_back(okResponse(
        R"({"is_cad_viewport":false,"objects":[{"id":"ghost","type":"motor","confidence":0.9,)"
        R"("features":[],"connected_to":[]}],"feature_tree":[],"notes":"a desktop"})"));
    VisionFacts none = vision.extract(img, "front", "", known, false);
    CHECK(!none.isCadViewport);
    CHECK_EQ(none.objects.size(), std::size_t{0});
}

TEST(vision_agent_classify_merges_check) {
    // The first frame does verification + classification + extraction in ONE
    // call — the old separate cadCheck image send is gone.
    MockTransport transport;
    transport.queue.push_back(okResponse(
        R"({"is_cad_viewport":true,"application":"Onshape","model_type":"mechanical_assembly",)"
        R"("purpose":"gearbox","objects":[{"id":"gear_1","type":"gear","confidence":0.8,)"
        R"("features":[],"connected_to":[]}],"feature_tree":[],"notes":"a gear assembly"})"));
    ClaudeClient client("k", "m", &transport);
    VisionAgent vision(&client);

    std::string img = writeTmp("classify.png", "bytes");
    KnowledgeGraph known;
    VisionFacts f = vision.extract(img, "initial", "User description: my gearbox", known,
                                   /*classify=*/true);
    CHECK(f.isCadViewport);
    CHECK_EQ(f.application, "Onshape");
    CHECK_EQ(f.modelType, "mechanical_assembly");
    CHECK_EQ(f.purpose, "gearbox");
    CHECK_EQ(f.objects.size(), std::size_t{1});  // still extracts objects in the same call

    // The classify schema carries the model-classification fields.
    Json body = Json::parse(transport.requests[0].body);
    const Json& props = body.at("output_config").at("format").at("schema").at("properties");
    CHECK(props.contains("model_type"));
    CHECK(props.contains("objects"));

    // First frame with empty graph -> no "Known objects" block (token saving).
    CHECK(body.at("messages")[0].at("content")[1].getString("text").find("Known objects") ==
          std::string::npos);
}

TEST(research_agent_offline) {
    KnowledgeGraph kg;
    GraphObject b;
    b.id = "bearing_1";
    b.type = "bearing";
    b.confidence = 0.8;
    kg.upsert(b);
    ResearchAgent research;
    auto evidence = research.research(kg);
    CHECK(!evidence.empty());
    bool foundBearing = false;
    for (const auto& e : evidence) {
        if (e.topic.find("bearing") != std::string::npos) foundBearing = true;
    }
    CHECK(foundBearing);

    KnowledgeGraph empty;
    CHECK(!research.research(empty).empty());
}

TEST(session_full_loop) {
    SessionHarness h;
    SessionConfig cfg;
    cfg.maxSteps = 4;
    cfg.minViews = 4;
    cfg.confidenceThreshold = 0.99;  // unreachable -> runs to maxSteps
    auto session = h.make(cfg);

    Report rep = session.run("a 3d printed gearbox");

    // initial + 3 planned views ("front","top","right"); "top" repeated the
    // bytes of "front" so exactly one vision-extract was skipped by dedup.
    CHECK_EQ(h.camera.captured.size(), std::size_t{4});
    CHECK_EQ(h.camera.captured[0], "initial");
    // The initial frame is verified+classified+extracted in ONE call (not a
    // separate cadCheck), so only 3 vision calls total for 3 analyzed frames.
    CHECK_EQ(h.vision.classifyCalls, 1);
    CHECK_EQ(h.vision.extractCalls, 3);
    CHECK_EQ(h.store.size(), std::size_t{3});
    CHECK_EQ(h.kg.objectCount(), std::size_t{3});
    CHECK(h.kg.featureTree().size() == 2);  // from "front"
    CHECK(h.store.wasSent("shot-1"));

    // user gave a prompt -> no clarification question
    CHECK_EQ(h.questions.size(), std::size_t{0});
    // context flowed to vision and engineering
    CHECK(!h.vision.contexts.empty());
    CHECK(h.vision.contexts[0].find("gearbox") != std::string::npos);
    CHECK(h.engineering.lastContext.find("gearbox") != std::string::npos);

    CHECK_EQ(rep.issues.size(), std::size_t{1});
    CHECK(rep.issues[0].description.find("3 objects") != std::string::npos);

    // state machine order: capture -> verify -> analyze -> plan -> research -> engineering -> done
    CHECK(phaseBefore(h.phases, "capture", "verify"));
    CHECK(phaseBefore(h.phases, "verify", "analyze"));
    CHECK(phaseBefore(h.phases, "analyze", "research"));
    CHECK(phaseBefore(h.phases, "research", "engineering"));
    CHECK_EQ(h.phases.back(), "done");
    CHECK(!h.shots.empty());
    CHECK(!h.notes.empty());
}

TEST(session_aborts_without_cad_viewport) {
    SessionHarness h;
    h.vision.isCad = false;  // verification says: not a CAD viewport
    auto session = h.make({});

    CHECK_THROWS(session.run("anything"));
    // Hard stop after the single initial call reports no CAD viewport: no
    // further views, no engineering, no report from unverified data.
    CHECK_EQ(h.vision.extractCalls, 1);
    CHECK_EQ(h.engineering.calls, 0);
}

TEST(session_clarifies_before_report) {
    // Cheap probe returns questions -> session pops them, collects answers, then
    // writes ONE report with the answers already in context (no re-listing, no
    // second full report).
    SessionHarness h;
    h.engineering.probeQuestions = {"What material is bracket_1?", "What is the peak load?"};
    h.cannedAnswer = "aluminium";  // harness answers every question with this
    SessionConfig cfg;
    cfg.minViews = 2;
    cfg.maxSteps = 2;
    auto session = h.make(cfg);
    session.run("a bracket");

    // Both questions were asked as popups, once...
    CHECK_EQ(h.questions.size(), std::size_t{2});
    CHECK_EQ(h.engineering.questionCalls, 1);
    // ...and the full report ran exactly ONCE (cheaper than the old 2x).
    CHECK_EQ(h.engineering.calls, 1);
    // The answers were folded into the report's context.
    CHECK(h.engineering.lastContext.find("aluminium") != std::string::npos);
    CHECK(h.engineering.lastContext.find("do NOT re-ask") != std::string::npos);
}

TEST(session_no_questions_single_report) {
    // No essential questions -> no popups, still exactly one report.
    SessionHarness h;
    h.engineering.probeQuestions = {};  // nothing to ask
    SessionConfig cfg;
    cfg.minViews = 2;
    cfg.maxSteps = 2;
    auto session = h.make(cfg);
    session.run("a bracket");

    CHECK_EQ(h.questions.size(), std::size_t{0});
    CHECK_EQ(h.engineering.questionCalls, 1);
    CHECK_EQ(h.engineering.calls, 1);
}

TEST(session_asks_when_model_unknown) {
    SessionHarness h;
    h.vision.modelType = "unknown";
    SessionConfig cfg;
    cfg.minViews = 2;
    cfg.maxSteps = 2;
    auto session = h.make(cfg);
    session.run("");  // empty prompt + unknown type -> must ask

    CHECK_EQ(h.questions.size(), std::size_t{1});
    CHECK(h.questions[0].find("intended to be") != std::string::npos);
    // The clarification is asked AFTER the initial frame is analyzed (we must
    // read the image to learn the type is unknown), so the "Robot" answer flows
    // into the SUBSEQUENT views' context, not the first.
    CHECK(h.vision.contexts.size() >= 2);
    CHECK(h.vision.contexts.back().find("Robot") != std::string::npos);

    // With a user prompt, no question is needed even if type is unknown.
    SessionHarness h2;
    h2.vision.modelType = "unknown";
    auto session2 = h2.make(cfg);
    session2.run("this is a drone frame");
    CHECK_EQ(h2.questions.size(), std::size_t{0});
}

TEST(session_enforces_min_views) {
    SessionHarness h;
    h.vision.confidence = 0.95;  // confident immediately...
    SessionConfig cfg;
    cfg.minViews = 3;
    cfg.maxSteps = 8;
    cfg.confidenceThreshold = 0.5;
    auto session = h.make(cfg);
    session.run("simple cube");

    // ...but the minimum of 3 views is still enforced.
    CHECK_EQ(h.camera.captured.size(), std::size_t{3});
}

TEST(cad_window_detection) {
    using platform::isBrowserApp;
    using platform::looksLikeCadWindow;
    CHECK(looksLikeCadWindow("Autodesk Fusion 360", "my_robot v12"));
    CHECK(looksLikeCadWindow("SOLIDWORKS 2024", "assembly.sldasm"));
    CHECK(looksLikeCadWindow("Google Chrome", "Gearbox - Onshape"));
    CHECK(!looksLikeCadWindow("Google Chrome", "YouTube"));
    CHECK(!looksLikeCadWindow("Google Chrome", ""));  // hidden title -> browser fallback path
    CHECK(!looksLikeCadWindow("Finder", ""));
    CHECK(isBrowserApp("Google Chrome"));
    CHECK(isBrowserApp("Arc"));
    CHECK(!isBrowserApp("Autodesk Fusion 360"));
}

TEST(orbit_style_selection) {
    CHECK(orbitStyleForApp("Autodesk Fusion 360") == OrbitStyle::ShiftMiddleDrag);
    CHECK(orbitStyleForApp("Google Chrome") == OrbitStyle::RightDrag);   // Onshape in browser
    CHECK(orbitStyleForApp("Full screen") == OrbitStyle::RightDrag);     // screenshot fallback
    CHECK(orbitStyleForApp("SOLIDWORKS") == OrbitStyle::MiddleDrag);
}

}  // namespace

int main() {
    for (const auto& t : registry()) {
        g_currentTest = t.name;
        std::printf("RUN  %s\n", t.name);
        try {
            t.fn();
        } catch (const std::exception& e) {
            ++g_failures;
            std::printf("  FAIL %s: unexpected exception: %s\n", t.name, e.what());
        }
    }
    std::printf("\n%d checks, %d failure(s), %zu test(s)\n", g_checks, g_failures,
                registry().size());
    return g_failures == 0 ? 0 : 1;
}

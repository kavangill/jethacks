#include "core/json.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace cadgod {

namespace {

struct Parser {
    const std::string& s;
    std::size_t i = 0;

    explicit Parser(const std::string& str) : s(str) {}

    [[noreturn]] void fail(const std::string& msg) const {
        throw std::runtime_error("JSON parse error at offset " + std::to_string(i) + ": " + msg);
    }

    void skipWs() {
        while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
    }

    char peek() const {
        if (i >= s.size()) throw std::runtime_error("JSON parse error: unexpected end of input");
        return s[i];
    }

    void expect(char c) {
        if (i >= s.size() || s[i] != c) fail(std::string("expected '") + c + "'");
        ++i;
    }

    bool literal(const char* lit) {
        std::size_t n = 0;
        while (lit[n]) ++n;
        if (s.compare(i, n, lit) != 0) return false;
        i += n;
        return true;
    }

    unsigned hex4() {
        unsigned v = 0;
        for (int k = 0; k < 4; ++k) {
            if (i >= s.size()) fail("truncated \\u escape");
            char c = s[i++];
            v <<= 4;
            if (c >= '0' && c <= '9') v |= static_cast<unsigned>(c - '0');
            else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
            else fail("invalid hex digit in \\u escape");
        }
        return v;
    }

    static void appendUtf8(std::string& out, unsigned cp) {
        if (cp < 0x80) {
            out += static_cast<char>(cp);
        } else if (cp < 0x800) {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (cp >> 18));
            out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }

    std::string parseString() {
        expect('"');
        std::string out;
        while (true) {
            if (i >= s.size()) fail("unterminated string");
            char c = s[i++];
            if (c == '"') break;
            if (c == '\\') {
                if (i >= s.size()) fail("truncated escape");
                char e = s[i++];
                switch (e) {
                    case '"': out += '"'; break;
                    case '\\': out += '\\'; break;
                    case '/': out += '/'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'n': out += '\n'; break;
                    case 'r': out += '\r'; break;
                    case 't': out += '\t'; break;
                    case 'u': {
                        unsigned cp = hex4();
                        if (cp >= 0xD800 && cp <= 0xDBFF) {
                            if (i + 1 < s.size() && s[i] == '\\' && s[i + 1] == 'u') {
                                i += 2;
                                unsigned lo = hex4();
                                if (lo >= 0xDC00 && lo <= 0xDFFF) {
                                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                } else {
                                    fail("invalid low surrogate");
                                }
                            } else {
                                fail("unpaired high surrogate");
                            }
                        }
                        appendUtf8(out, cp);
                        break;
                    }
                    default: fail("invalid escape character");
                }
            } else {
                out += c;
            }
        }
        return out;
    }

    Json parseNumber() {
        std::size_t start = i;
        if (i < s.size() && s[i] == '-') ++i;
        while (i < s.size() && (std::isdigit(static_cast<unsigned char>(s[i])) || s[i] == '.' ||
                                s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) {
            ++i;
        }
        std::string num = s.substr(start, i - start);
        char* end = nullptr;
        double v = std::strtod(num.c_str(), &end);
        if (end == num.c_str() || *end != '\0') fail("invalid number '" + num + "'");
        return Json(v);
    }

    Json parseValue() {
        skipWs();
        char c = peek();
        switch (c) {
            case '{': return parseObject();
            case '[': return parseArray();
            case '"': return Json(parseString());
            case 't':
                if (literal("true")) return Json(true);
                fail("invalid literal");
            case 'f':
                if (literal("false")) return Json(false);
                fail("invalid literal");
            case 'n':
                if (literal("null")) return Json(nullptr);
                fail("invalid literal");
            default:
                if (c == '-' || std::isdigit(static_cast<unsigned char>(c))) return parseNumber();
                fail("unexpected character");
        }
    }

    Json parseObject() {
        expect('{');
        Json::Object obj;
        skipWs();
        if (peek() == '}') { ++i; return Json(std::move(obj)); }
        while (true) {
            skipWs();
            std::string key = parseString();
            skipWs();
            expect(':');
            obj[key] = parseValue();
            skipWs();
            char c = peek();
            if (c == ',') { ++i; continue; }
            if (c == '}') { ++i; break; }
            fail("expected ',' or '}'");
        }
        return Json(std::move(obj));
    }

    Json parseArray() {
        expect('[');
        Json::Array arr;
        skipWs();
        if (peek() == ']') { ++i; return Json(std::move(arr)); }
        while (true) {
            arr.push_back(parseValue());
            skipWs();
            char c = peek();
            if (c == ',') { ++i; continue; }
            if (c == ']') { ++i; break; }
            fail("expected ',' or ']'");
        }
        return Json(std::move(arr));
    }
};

}  // namespace

Json Json::parse(const std::string& text) {
    Parser p(text);
    Json v = p.parseValue();
    p.skipWs();
    if (p.i != text.size()) p.fail("trailing characters");
    return v;
}

bool Json::contains(const std::string& key) const {
    const Object* obj = std::get_if<Object>(&value_);
    return obj && obj->count(key) > 0;
}

const Json& Json::at(const std::string& key) const {
    const Object& obj = get<Object>("object");
    auto it = obj.find(key);
    if (it == obj.end()) throw std::runtime_error("Json: missing key '" + key + "'");
    return it->second;
}

const Json* Json::find(const std::string& key) const {
    const Object* obj = std::get_if<Object>(&value_);
    if (!obj) return nullptr;
    auto it = obj->find(key);
    return it == obj->end() ? nullptr : &it->second;
}

Json& Json::operator[](const std::string& key) {
    if (isNull()) value_ = Object{};
    return get<Object>("object")[key];
}

std::string Json::getString(const std::string& key, const std::string& def) const {
    const Json* v = find(key);
    return (v && v->isString()) ? v->asString() : def;
}

double Json::getNumber(const std::string& key, double def) const {
    const Json* v = find(key);
    return (v && v->isNumber()) ? v->asNumber() : def;
}

const Json& Json::operator[](std::size_t i) const {
    const Array& arr = get<Array>("array");
    if (i >= arr.size()) throw std::runtime_error("Json: index out of range");
    return arr[i];
}

void Json::push_back(Json v) {
    if (isNull()) value_ = Array{};
    get<Array>("array").push_back(std::move(v));
}

std::size_t Json::size() const {
    if (const Array* a = std::get_if<Array>(&value_)) return a->size();
    if (const Object* o = std::get_if<Object>(&value_)) return o->size();
    return 0;
}

void Json::dumpString(const std::string& s, std::string& out) {
    out += '"';
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    out += '"';
}

void Json::dumpTo(std::string& out) const {
    if (isNull()) { out += "null"; return; }
    if (const bool* b = std::get_if<bool>(&value_)) { out += *b ? "true" : "false"; return; }
    if (const double* n = std::get_if<double>(&value_)) {
        if (std::isfinite(*n) && *n == std::floor(*n) && std::fabs(*n) < 9e15) {
            out += std::to_string(static_cast<long long>(*n));
        } else {
            char buf[32];
            std::snprintf(buf, sizeof buf, "%.17g", *n);
            out += buf;
        }
        return;
    }
    if (const std::string* s = std::get_if<std::string>(&value_)) { dumpString(*s, out); return; }
    if (const Array* a = std::get_if<Array>(&value_)) {
        out += '[';
        for (std::size_t k = 0; k < a->size(); ++k) {
            if (k) out += ',';
            (*a)[k].dumpTo(out);
        }
        out += ']';
        return;
    }
    const Object& o = std::get<Object>(value_);
    out += '{';
    bool first = true;
    for (const auto& [k, v] : o) {
        if (!first) out += ',';
        first = false;
        dumpString(k, out);
        out += ':';
        v.dumpTo(out);
    }
    out += '}';
}

std::string Json::dump() const {
    std::string out;
    dumpTo(out);
    return out;
}

}  // namespace cadgod

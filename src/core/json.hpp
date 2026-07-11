#pragma once
// Minimal dependency-free JSON value type: parse + serialize.
// Objects use std::map so serialization order is deterministic (stable for
// prompt caching).

#include <cstddef>
#include <map>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace cadgod {

class Json {
public:
    using Array = std::vector<Json>;
    using Object = std::map<std::string, Json>;

    Json() : value_(nullptr) {}
    Json(std::nullptr_t) : value_(nullptr) {}
    Json(bool b) : value_(b) {}
    Json(int n) : value_(static_cast<double>(n)) {}
    Json(long long n) : value_(static_cast<double>(n)) {}
    Json(std::size_t n) : value_(static_cast<double>(n)) {}
    Json(double n) : value_(n) {}
    Json(const char* s) : value_(std::string(s)) {}
    Json(std::string s) : value_(std::move(s)) {}
    Json(Array a) : value_(std::move(a)) {}
    Json(Object o) : value_(std::move(o)) {}

    static Json array() { return Json(Array{}); }
    static Json object() { return Json(Object{}); }
    static Json parse(const std::string& text);  // throws std::runtime_error

    bool isNull() const { return std::holds_alternative<std::nullptr_t>(value_); }
    bool isBool() const { return std::holds_alternative<bool>(value_); }
    bool isNumber() const { return std::holds_alternative<double>(value_); }
    bool isString() const { return std::holds_alternative<std::string>(value_); }
    bool isArray() const { return std::holds_alternative<Array>(value_); }
    bool isObject() const { return std::holds_alternative<Object>(value_); }

    bool asBool() const { return get<bool>("bool"); }
    double asNumber() const { return get<double>("number"); }
    const std::string& asString() const { return get<std::string>("string"); }

    // Object access
    bool contains(const std::string& key) const;
    const Json& at(const std::string& key) const;      // throws if absent
    const Json* find(const std::string& key) const;    // nullptr if absent
    Json& operator[](const std::string& key);          // creates; null -> object
    std::string getString(const std::string& key, const std::string& def = "") const;
    double getNumber(const std::string& key, double def = 0.0) const;

    // Array access
    const Json& operator[](std::size_t i) const;
    void push_back(Json v);

    std::size_t size() const;
    const Array& items() const { return get<Array>("array"); }
    const Object& fields() const { return get<Object>("object"); }

    std::string dump() const;

private:
    template <typename T>
    const T& get(const char* name) const {
        if (const T* p = std::get_if<T>(&value_)) return *p;
        throw std::runtime_error(std::string("Json: not a ") + name);
    }
    template <typename T>
    T& get(const char* name) {
        if (T* p = std::get_if<T>(&value_)) return *p;
        throw std::runtime_error(std::string("Json: not a ") + name);
    }
    void dumpTo(std::string& out) const;
    static void dumpString(const std::string& s, std::string& out);

    std::variant<std::nullptr_t, bool, double, std::string, Array, Object> value_;
};

}  // namespace cadgod

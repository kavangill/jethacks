#include "core/env.hpp"

#include <cstdlib>
#include <fstream>

namespace cadgod {

namespace {

std::string trim(const std::string& s) {
    std::size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    std::size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

}  // namespace

std::map<std::string, std::string> loadEnvFile(const std::string& path) {
    std::map<std::string, std::string> out;
    std::ifstream f(path);
    if (!f) return out;
    std::string line;
    while (std::getline(f, line)) {
        std::string t = trim(line);
        if (t.empty() || t[0] == '#') continue;
        if (t.rfind("export ", 0) == 0) t = trim(t.substr(7));
        std::size_t eq = t.find('=');
        if (eq == std::string::npos) continue;
        std::string key = trim(t.substr(0, eq));
        std::string val = trim(t.substr(eq + 1));
        if (key.empty()) continue;
        if (val.size() >= 2 && ((val.front() == '"' && val.back() == '"') ||
                                (val.front() == '\'' && val.back() == '\''))) {
            val = val.substr(1, val.size() - 2);
        }
        out[key] = val;
    }
    return out;
}

std::string configValue(const std::string& key,
                        const std::map<std::string, std::string>& fileEnv,
                        const std::string& fallback) {
    if (const char* v = std::getenv(key.c_str()); v && *v) return v;
    auto it = fileEnv.find(key);
    if (it != fileEnv.end() && !it->second.empty()) return it->second;
    return fallback;
}

}  // namespace cadgod

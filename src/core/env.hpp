#pragma once
// .env file loading. Process environment always wins over file values so the
// user can override per-invocation.

#include <map>
#include <string>

namespace cadgod {

// Parses KEY=VALUE lines. Supports comments (#), blank lines, optional
// `export ` prefix, and single/double quoted values. Missing file -> empty map.
std::map<std::string, std::string> loadEnvFile(const std::string& path);

// Resolution order: process env var, then file value, then fallback.
std::string configValue(const std::string& key,
                        const std::map<std::string, std::string>& fileEnv,
                        const std::string& fallback = "");

}  // namespace cadgod

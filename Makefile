# CADGOD — CAD Inspection Copilot (macOS, no external build deps: clang++ + make)

CXX        := clang++
CXXFLAGS   := -std=c++20 -Wall -Wextra -O2 -Isrc
OBJCXXFLAGS := $(CXXFLAGS) -fobjc-arc
LDLIBS     := -lcurl
FRAMEWORKS := -framework AppKit -framework CoreGraphics -framework ApplicationServices

BUILD := build

CORE_SRCS := \
	src/core/json.cpp \
	src/core/env.cpp \
	src/core/knowledge_graph.cpp \
	src/core/screenshot_store.cpp \
	src/core/claude_client.cpp \
	src/core/agents.cpp \
	src/core/session.cpp \
	src/platform/platform_common.cpp

CORE_OBJS    := $(CORE_SRCS:src/%.cpp=$(BUILD)/%.o)
MAC_OBJ      := $(BUILD)/platform/mac_platform.o
APP_COMMON   := $(BUILD)/app/app_common.o
CLI_OBJ      := $(BUILD)/app/main.o
OVERLAY_OBJ  := $(BUILD)/app/overlay_app.o
TEST_OBJ     := $(BUILD)/tests/test_main.o

.PHONY: all clean test cli overlay

all: $(BUILD)/cadgod $(BUILD)/cadgod-overlay $(BUILD)/cadgod-tests

cli: $(BUILD)/cadgod
overlay: $(BUILD)/cadgod-overlay

$(BUILD)/%.o: src/%.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/%.o: src/%.mm
	@mkdir -p $(dir $@)
	$(CXX) $(OBJCXXFLAGS) -c $< -o $@

$(BUILD)/tests/test_main.o: tests/test_main.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/cadgod: $(CORE_OBJS) $(MAC_OBJ) $(APP_COMMON) $(CLI_OBJ)
	$(CXX) $^ -o $@ $(LDLIBS) $(FRAMEWORKS)

$(BUILD)/cadgod-overlay: $(CORE_OBJS) $(MAC_OBJ) $(APP_COMMON) $(OVERLAY_OBJ)
	$(CXX) $^ -o $@ $(LDLIBS) $(FRAMEWORKS)

$(BUILD)/cadgod-tests: $(CORE_OBJS) $(TEST_OBJ)
	$(CXX) $^ -o $@ $(LDLIBS)

test: $(BUILD)/cadgod-tests
	./$(BUILD)/cadgod-tests

clean:
	rm -rf $(BUILD)

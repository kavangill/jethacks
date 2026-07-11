// CADGOD overlay — Cursor-style engineering tool window.
//
// Layout: a 16:9 resizable, chromeless floating window of three rounded
// "islands" stacked with gaps:
//   top    : title, permission indicators, window picker, debug toggle, refresh
//   middle : inspection checklist (left) + output log (right, side by side)
//   bottom : prompt input + Inspect button
//
// Behavior: prompt-driven. On send it verifies permissions, resolves/attaches
// the target window, takes an immediate screenshot, and only proceeds when
// vision confirms a real CAD viewport. Clarifying questions appear as modal
// popups (mid-run too — the AI asks, you answer or skip, then it continues).
// Errors are shown and logged — the app never silently shuts down.

#import <AppKit/AppKit.h>

#include <algorithm>
#include <execinfo.h>
#include <fcntl.h>
#include <os/lock.h>
#include <signal.h>
#include <string.h>
#include <string>
#include <unistd.h>
#include <vector>

#include "app/app_common.hpp"
#include "platform/platform.hpp"

using cadgod::app::InspectConfig;
using cadgod::platform::WindowInfo;

// UTF-8-safe NSString from a std::string. Model/user text contains non-ASCII
// (em-dashes, arrows, degree signs); passing that through `%s` in
// +stringWithFormat: mis-decodes it, and stringWithUTF8String: returns nil on
// any invalid byte. This never returns nil.
static NSString* SafeStr(const std::string& s) {
    NSData* data = [NSData dataWithBytes:s.data() length:(NSUInteger)s.size()];
    NSString* out = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!out) out = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
    return out ?: @"";
}

static NSString* SessionLogPath() {
    return [@"~/Desktop/cadgod-session.log" stringByExpandingTildeInPath];
}

// Appends one timestamped line to the session log and flushes to disk before
// returning, so even a hard kill (e.g. OOM, which no handler can catch) still
// leaves the exact last action on disk. Synchronous + mutex-guarded; the volume
// is a few dozen lines per run, so the cost is negligible. Safe from any thread.
static void SessionLog(NSString* line) {
    if (!line) line = @"(nil)";
    static os_unfair_lock lock = OS_UNFAIR_LOCK_INIT;
    NSString* stamped = [NSString stringWithFormat:@"%@  %@\n", [NSDate date].description, line];
    const char* bytes = stamped.UTF8String ?: "(encode-failed)\n";
    const char* path = SessionLogPath().fileSystemRepresentation;
    os_unfair_lock_lock(&lock);
    FILE* f = fopen(path, "a");
    if (f) {
        fputs(bytes, f);
        fflush(f);
        fclose(f);
    }
    os_unfair_lock_unlock(&lock);
}

// Timeline phases in display order; session phase keys map onto these.
static NSArray<NSString*>* kTimelineSteps = @[
    @"Attach window", @"Capture screenshot", @"Verify CAD viewport", @"Vision analysis",
    @"Knowledge graph", @"Plan next view", @"Research", @"Engineering review", @"Report"
];

static NSInteger timelineIndexForPhase(const std::string& phase) {
    if (phase == "attach") return 0;
    if (phase == "capture") return 1;
    if (phase == "verify") return 2;
    if (phase == "question") return 2;
    if (phase == "analyze") return 3;
    if (phase == "graph") return 4;
    if (phase == "plan") return 5;
    if (phase == "research") return 6;
    if (phase == "engineering") return 7;
    if (phase == "done") return 8;
    return -1;
}

@interface CadgodOverlay : NSObject <NSApplicationDelegate, NSWindowDelegate, NSSplitViewDelegate>
@end

@implementation CadgodOverlay {
    NSWindow* _window;
    NSTextField* _permLabel;
    NSPopUpButton* _windowPicker;
    NSButton* _debugToggle;
    NSTextView* _timelineView;
    NSTextView* _chatView;
    NSScrollView* _chatScroll;
    NSSplitView* _split;
    NSTextField* _promptField;
    NSButton* _sendButton;

    std::vector<WindowInfo> _pickerWindows;
    NSInteger _timelineActive;   // current step; -1 idle
    NSInteger _timelineReached;  // highest step reached
    BOOL _timelineFailed;
    BOOL _running;
}

// ------------------------------------------------------------- UI helpers --

- (NSTextView*)makeTextViewInScroll:(NSScrollView**)scrollOut editable:(BOOL)editable {
    NSScrollView* scroll = [[NSScrollView alloc] init];
    scroll.translatesAutoresizingMaskIntoConstraints = NO;
    scroll.hasVerticalScroller = YES;
    scroll.drawsBackground = NO;  // transparent -> sits on the frosted island
    scroll.borderType = NSNoBorder;

    NSTextView* tv = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)];
    tv.editable = editable;
    tv.selectable = YES;
    tv.richText = YES;
    tv.drawsBackground = NO;
    tv.textColor = [NSColor whiteColor];
    tv.font = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    tv.textContainerInset = NSMakeSize(6, 6);
    tv.autoresizingMask = NSViewWidthSizable;
    tv.minSize = NSMakeSize(0, 0);
    tv.maxSize = NSMakeSize(FLT_MAX, FLT_MAX);
    tv.verticallyResizable = YES;
    tv.horizontallyResizable = NO;
    tv.textContainer.widthTracksTextView = YES;

    scroll.documentView = tv;
    *scrollOut = scroll;
    return tv;
}

- (void)appendChat:(NSString*)text color:(NSColor*)color bold:(BOOL)bold {
    NSString* safeText = text ?: @"";
    SessionLog(safeText);  // persist first, so a crash mid-render still leaves a trail
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            NSFont* font = bold ? [NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightSemibold]
                                : [NSFont monospacedSystemFontOfSize:11.5 weight:NSFontWeightRegular];
            NSAttributedString* s = [[NSAttributedString alloc]
                initWithString:[safeText stringByAppendingString:@"\n"]
                    attributes:@{NSFontAttributeName : font,
                                 NSForegroundColorAttributeName : color ?: [NSColor labelColor]}];
            [self->_chatView.textStorage appendAttributedString:s];
            [self->_chatView scrollToEndOfDocument:nil];
        } @catch (NSException* ex) {
            SessionLog([@"appendChat EXCEPTION: " stringByAppendingString:ex.reason ?: ex.name]);
        }
    });
}

// Inline formatter: turns `**bold**` and `` `code` `` runs into styled text.
+ (void)appendInline:(NSString*)line
                  to:(NSMutableAttributedString*)out
                font:(NSFont*)font
               color:(NSColor*)color {
    NSFont* bold = [[NSFontManager sharedFontManager] convertFont:font toHaveTrait:NSBoldFontMask];
    NSArray<NSString*>* segs = [line componentsSeparatedByString:@"**"];
    for (NSUInteger i = 0; i < segs.count; ++i) {
        NSString* seg = segs[i];
        if (!seg.length) continue;
        BOOL isBold = (i % 2) == 1;  // text between ** pairs
        [out appendAttributedString:[[NSAttributedString alloc]
                                        initWithString:seg
                                            attributes:@{
                                                NSFontAttributeName : isBold ? bold : font,
                                                NSForegroundColorAttributeName : color
                                            }]];
    }
}

// Renders the subset of Markdown the agents emit (#/##/### headings, - bullets,
// **bold**) into a styled attributed string — so the report reads like prose,
// not raw `##`/`**` syntax.
+ (NSAttributedString*)renderMarkdown:(NSString*)md {
    NSMutableAttributedString* out = [[NSMutableAttributedString alloc] init];
    NSColor* body = [NSColor labelColor];
    NSColor* head = [NSColor whiteColor];
    NSColor* muted = [NSColor secondaryLabelColor];
    NSColor* accent = [NSColor colorWithWhite:0.55 alpha:1.0];
    for (NSString* raw in [md componentsSeparatedByString:@"\n"]) {
        NSString* line = raw;
        NSString* trimmed =
            [line stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];

        // Horizontal rule for `---`: a full-width thin divider line.
        if ([trimmed isEqualToString:@"---"] || [trimmed isEqualToString:@"***"]) {
            NSUInteger s = out.length;
            [out appendAttributedString:
                     [[NSAttributedString alloc]
                         initWithString:@" \n"
                             attributes:@{NSStrikethroughStyleAttributeName : @(NSUnderlineStyleSingle),
                                          NSStrikethroughColorAttributeName : [NSColor colorWithWhite:1 alpha:0.15],
                                          NSFontAttributeName : [NSFont systemFontOfSize:6],
                                          NSExpansionAttributeName : @(3.0)}]];
            NSMutableParagraphStyle* p = [[NSMutableParagraphStyle alloc] init];
            p.paragraphSpacingBefore = 6;
            p.paragraphSpacing = 6;
            [out addAttribute:NSParagraphStyleAttributeName value:p range:NSMakeRange(s, out.length - s)];
            continue;
        }

        NSFont* font = [NSFont systemFontOfSize:12];
        NSColor* color = body;
        BOOL isHeading = NO;
        if ([line hasPrefix:@"### "]) {
            line = [line substringFromIndex:4]; font = [NSFont boldSystemFontOfSize:12.5];
            color = head; isHeading = YES;
        } else if ([line hasPrefix:@"## "]) {
            line = [line substringFromIndex:3]; font = [NSFont boldSystemFontOfSize:13.5];
            color = head; isHeading = YES;
        } else if ([line hasPrefix:@"# "]) {
            line = [line substringFromIndex:2]; font = [NSFont boldSystemFontOfSize:15];
            color = head; isHeading = YES;
        } else if ([line hasPrefix:@"- "] || [line hasPrefix:@"* "]) {
            line = [@"   •  " stringByAppendingString:[line substringFromIndex:2]];
        } else if ([trimmed hasPrefix:@"_"]) {
            color = muted;  // italic-ish "_None._" placeholders
        }
        // Recolor the leading marker glyphs (▸ issues, ● questions) so they pop.
        NSUInteger start = out.length;
        if ([line hasPrefix:@"▸ "] || [line hasPrefix:@"● "]) {
            [out appendAttributedString:[[NSAttributedString alloc]
                                            initWithString:[line substringToIndex:2]
                                                attributes:@{NSFontAttributeName : font,
                                                             NSForegroundColorAttributeName : accent}]];
            line = [line substringFromIndex:2];
        }
        [self appendInline:line to:out font:font color:color];
        [out appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"]];
        NSMutableParagraphStyle* p = [[NSMutableParagraphStyle alloc] init];
        p.paragraphSpacingBefore = isHeading ? 8 : 1;
        p.paragraphSpacing = 3;
        p.lineSpacing = 1;
        [out addAttribute:NSParagraphStyleAttributeName value:p range:NSMakeRange(start, out.length - start)];
    }
    return out;
}

- (void)appendMarkdown:(NSString*)md {
    SessionLog(@"appendMarkdown (report)");
    NSString* safe = md ?: @"";
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            [self->_chatView.textStorage
                appendAttributedString:[CadgodOverlay renderMarkdown:safe]];
            [self->_chatView scrollToEndOfDocument:nil];
        } @catch (NSException* ex) {
            SessionLog([@"appendMarkdown EXCEPTION: " stringByAppendingString:ex.reason ?: ex.name]);
        }
    });
}

// Downscales the source image to a small thumbnail bitmap. CRITICAL for
// stability: a full-screen retina capture decodes to ~20-30 MB, and every
// screenshot attachment stays resident in the text view for the whole session.
// Keeping the full-res images alive (and re-rasterizing them on each append)
// exhausts memory / crashes TextKit after a few captures. We keep only a
// ~360px-wide copy; the big source is released as soon as this returns.
+ (NSImage*)thumbnailFromPath:(NSString*)path maxWidth:(CGFloat)maxW {
    // Decode straight to a bitmap rep and render the downscaled copy into a
    // fresh, fully-backed NSBitmapImageRep. The previous lockFocus/unlockFocus
    // approach produced an NSImage with no serializable representation, which
    // made ImageIO log "CGImageDestinationFinalize failed" and left AppKit in a
    // bad state when TextKit tried to cache it. This path is self-contained and
    // safe to reuse in the text view.
    NSData* data = [NSData dataWithContentsOfFile:path];
    if (!data) return nil;
    NSBitmapImageRep* srcRep = [NSBitmapImageRep imageRepWithData:data];
    if (!srcRep) return nil;
    NSInteger sw = srcRep.pixelsWide;
    NSInteger sh = srcRep.pixelsHigh;
    if (sw <= 0 || sh <= 0) return nil;

    CGFloat scale = (CGFloat)sw > maxW ? maxW / (CGFloat)sw : 1.0;
    NSInteger tw = (NSInteger)lround(sw * scale);
    NSInteger th = (NSInteger)lround(sh * scale);
    if (tw < 1) tw = 1;
    if (th < 1) th = 1;

    NSBitmapImageRep* dstRep =
        [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
                                                pixelsWide:tw
                                                pixelsHigh:th
                                             bitsPerSample:8
                                           samplesPerPixel:4
                                                  hasAlpha:YES
                                                  isPlanar:NO
                                            colorSpaceName:NSCalibratedRGBColorSpace
                                               bytesPerRow:0
                                              bitsPerPixel:0];
    if (!dstRep) return nil;

    NSGraphicsContext* ctx = [NSGraphicsContext graphicsContextWithBitmapImageRep:dstRep];
    if (!ctx) return nil;
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:ctx];
    [srcRep drawInRect:NSMakeRect(0, 0, tw, th)];
    [NSGraphicsContext restoreGraphicsState];

    NSImage* thumb = [[NSImage alloc] initWithSize:NSMakeSize(tw, th)];
    [thumb addRepresentation:dstRep];
    return thumb;
}

- (void)appendChatImage:(NSString*)path caption:(NSString*)caption {
    SessionLog([@"appendChatImage: " stringByAppendingString:(path ?: @"(nil)")]);
    dispatch_async(dispatch_get_main_queue(), ^{
        // This whole block runs on the main thread (outside the worker's
        // @try/@catch), so it must guard itself — an exception in TextKit
        // image layout here would otherwise abort the whole app.
        @try {
            NSImage* thumb = [CadgodOverlay thumbnailFromPath:path maxWidth:360];
            SessionLog(thumb ? @"  thumbnail ok" : @"  thumbnail nil (skipped)");
            if (thumb) {
                NSTextAttachment* attachment = [[NSTextAttachment alloc] init];
                attachment.image = thumb;
                attachment.bounds = NSMakeRect(0, 0, thumb.size.width, thumb.size.height);
                NSMutableAttributedString* s = [[NSAttributedString
                    attributedStringWithAttachment:attachment] mutableCopy];
                [s appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"]];
                [self->_chatView.textStorage appendAttributedString:s];
            }
            if (caption.length) {
                NSAttributedString* cap = [[NSAttributedString alloc]
                    initWithString:[caption stringByAppendingString:@"\n"]
                        attributes:@{
                            NSFontAttributeName :
                                [NSFont monospacedSystemFontOfSize:10.5 weight:NSFontWeightRegular],
                            NSForegroundColorAttributeName : [NSColor secondaryLabelColor]
                        }];
                [self->_chatView.textStorage appendAttributedString:cap];
            }
            [self->_chatView scrollToEndOfDocument:nil];
        } @catch (NSException* ex) {
            SessionLog([@"  appendChatImage EXCEPTION: " stringByAppendingString:ex.reason ?: ex.name]);
        }
    });
}

- (void)renderTimeline {
    dispatch_async(dispatch_get_main_queue(), ^{
      @try {
        NSMutableAttributedString* out = [[NSMutableAttributedString alloc] init];
        NSAttributedString* header = [[NSAttributedString alloc]
            initWithString:@"CHECKLIST\n\n"
                attributes:@{
                    NSFontAttributeName : [NSFont monospacedSystemFontOfSize:9.5
                                                                      weight:NSFontWeightBold],
                    NSForegroundColorAttributeName : [NSColor colorWithWhite:0.62 alpha:1.0]
                }];
        [out appendAttributedString:header];
        NSColor* pending = [NSColor colorWithWhite:0.72 alpha:1.0];  // clearly visible by default
        for (NSInteger i = 0; i < (NSInteger)kTimelineSteps.count; ++i) {
            NSString* mark;
            NSColor* color;
            if (self->_timelineFailed && i == self->_timelineActive) {
                mark = @"✗";
                color = [NSColor systemRedColor];
            } else if (i == self->_timelineActive && self->_running) {
                mark = @"▶";
                color = [NSColor systemTealColor];
            } else if (i <= self->_timelineReached &&
                       (self->_timelineReached > i || !self->_running)) {
                mark = @"✓";
                color = [NSColor systemGreenColor];
            } else if (i < self->_timelineActive) {
                mark = @"✓";
                color = [NSColor systemGreenColor];
            } else {
                mark = @"○";
                color = pending;
            }
            NSString* line = [NSString stringWithFormat:@" %@  %@\n", mark, kTimelineSteps[i]];
            [out appendAttributedString:
                     [[NSAttributedString alloc]
                         initWithString:line
                             attributes:@{
                                 NSFontAttributeName :
                                     [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular],
                                 NSForegroundColorAttributeName : color
                             }]];
        }
        [self->_timelineView.textStorage setAttributedString:out];
      } @catch (NSException* ex) {
        SessionLog([@"renderTimeline EXCEPTION: " stringByAppendingString:ex.reason ?: ex.name]);
      }
    });
}

- (void)setPhase:(const std::string&)phase {
    NSInteger idx = timelineIndexForPhase(phase);
    if (idx < 0) return;
    // Callbacks fire on the worker thread; keep all timeline-ivar access on the
    // main thread so it can't race with renderTimeline.
    dispatch_async(dispatch_get_main_queue(), ^{
        self->_timelineActive = idx;
        if (idx > self->_timelineReached) self->_timelineReached = idx;
        [self renderTimeline];
    });
}

- (void)refreshPermissions {
    BOOL screen = cadgod::platform::hasScreenRecordingPermission();
    BOOL ax = cadgod::platform::hasAccessibilityPermission(false);
    dispatch_async(dispatch_get_main_queue(), ^{
        self->_permLabel.stringValue =
            [NSString stringWithFormat:@"%@ screen recording    %@ accessibility",
                                       screen ? @"🟢" : @"🔴", ax ? @"🟢" : @"🔴"];
    });
}

- (void)refreshWindowList {
    auto wm = cadgod::platform::makeWindowManager();
    _pickerWindows = wm->listWindows();
    dispatch_async(dispatch_get_main_queue(), ^{
        [self->_windowPicker removeAllItems];
        [self->_windowPicker addItemWithTitle:@"Auto-detect window"];
        [self->_windowPicker addItemWithTitle:@"Full screen (screenshot-only)"];
        for (const auto& w : self->_pickerWindows) {
            NSString* flag = w.isCad ? @"◆ " : (w.isBrowser ? @"◇ " : @"   ");
            NSString* title = [NSString
                stringWithFormat:@"%@%@ — %@", flag, SafeStr(w.app),
                                 SafeStr(w.title.empty() ? "(untitled)" : w.title)];
            [self->_windowPicker addItemWithTitle:title];
        }
    });
}

// -------------------------------------------------------------- lifecycle --

- (void)applicationDidFinishLaunching:(NSNotification*)note {
    // Ask for permissions up front — the old build never triggered these.
    cadgod::platform::requestScreenRecordingPermission();
    cadgod::platform::hasAccessibilityPermission(true);

    // Overlay window: starts at a 16:9 size but freely resizable to any shape
    // (drag any edge/corner), floating on top, never captured in screenshots.
    NSRect start = NSMakeRect(0, 0, 680, 383);  // 16:9 default
    _window = [[NSWindow alloc]
        initWithContentRect:start
                  styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskFullSizeContentView |
                             NSWindowStyleMaskResizable)
                    backing:NSBackingStoreBuffered
                      defer:NO];
    _window.title = @"CADGOD";
    // 16:9 is just the DEFAULT size — no aspectRatio lock, so you can drag any
    // edge/corner to squish it to whatever shape you want, as small as you like.
    _window.minSize = NSMakeSize(280, 170);
    _window.level = NSFloatingWindowLevel;
    _window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    _window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                 NSWindowCollectionBehaviorFullScreenAuxiliary;
    _window.hidesOnDeactivate = NO;
    _window.sharingType = NSWindowSharingNone;  // never in screenshots
    // Chromeless + TRANSPARENT window: no overall background panel, so only the
    // solid island cards show — they float independently over the CAD app with
    // the gaps between them see-through. Whole background draggable, ⌘Q quits.
    _window.titlebarAppearsTransparent = YES;
    _window.titleVisibility = NSWindowTitleHidden;
    _window.movableByWindowBackground = YES;
    _window.opaque = NO;
    _window.backgroundColor = [NSColor clearColor];
    _window.hasShadow = NO;
    [_window standardWindowButton:NSWindowCloseButton].hidden = YES;
    [_window standardWindowButton:NSWindowMiniaturizeButton].hidden = YES;
    [_window standardWindowButton:NSWindowZoomButton].hidden = YES;

    NSView* root = [[NSView alloc] initWithFrame:start];  // transparent container
    _window.contentView = root;

    // Three SOLID rounded island cards floating over the transparent window.
    NSView* topIsland = [CadgodOverlay makeIsland];
    NSView* midIsland = [CadgodOverlay makeIsland];
    NSView* inputIsland = [CadgodOverlay makeIsland];

    // --- top island: close + title + permissions + window picker + debug + refresh ---
    NSButton* closeButton = [NSButton buttonWithTitle:@"✕" target:self action:@selector(onQuit:)];
    closeButton.bezelStyle = NSBezelStyleRegularSquare;
    closeButton.bordered = NO;
    closeButton.font = [NSFont boldSystemFontOfSize:13];
    NSMutableAttributedString* closeTitle =
        [[NSMutableAttributedString alloc] initWithAttributedString:closeButton.attributedTitle];
    [closeTitle addAttribute:NSForegroundColorAttributeName
                       value:[NSColor systemRedColor]
                       range:NSMakeRange(0, closeTitle.length)];
    closeButton.attributedTitle = closeTitle;
    closeButton.translatesAutoresizingMaskIntoConstraints = NO;

    NSTextField* title = [NSTextField labelWithString:@"CADGOD"];
    title.font = [NSFont boldSystemFontOfSize:13];
    title.textColor = [NSColor whiteColor];
    title.translatesAutoresizingMaskIntoConstraints = NO;

    _permLabel = [NSTextField labelWithString:@""];
    _permLabel.font = [NSFont systemFontOfSize:10];
    _permLabel.textColor = [NSColor secondaryLabelColor];
    _permLabel.translatesAutoresizingMaskIntoConstraints = NO;

    _windowPicker = [[NSPopUpButton alloc] init];
    _windowPicker.translatesAutoresizingMaskIntoConstraints = NO;
    _windowPicker.controlSize = NSControlSizeSmall;
    _windowPicker.font = [NSFont systemFontOfSize:11];

    _debugToggle = [NSButton checkboxWithTitle:@"Debug" target:nil action:nil];
    _debugToggle.controlSize = NSControlSizeSmall;
    _debugToggle.font = [NSFont systemFontOfSize:11];
    _debugToggle.translatesAutoresizingMaskIntoConstraints = NO;

    NSButton* refresh = [NSButton buttonWithTitle:@"↻" target:self action:@selector(onRefresh:)];
    refresh.bezelStyle = NSBezelStyleRecessed;
    refresh.translatesAutoresizingMaskIntoConstraints = NO;

    for (NSView* v in @[ closeButton, title, _permLabel, _windowPicker, _debugToggle, refresh ]) {
        [topIsland addSubview:v];
    }
    NSDictionary* top = @{
        @"close" : closeButton, @"title" : title, @"perm" : _permLabel, @"picker" : _windowPicker,
        @"debug" : _debugToggle, @"refresh" : refresh,
    };
    [topIsland addConstraints:[NSLayoutConstraint
                                  constraintsWithVisualFormat:
                                      @"H:|-10-[close(24)]-8-[title]-8-[perm]-(>=8)-[picker(<=240)]-6-[debug]-6-[refresh(24)]-10-|"
                                                      options:NSLayoutFormatAlignAllCenterY
                                                      metrics:nil
                                                        views:top]];
    [topIsland addConstraint:[NSLayoutConstraint constraintWithItem:title
                                                          attribute:NSLayoutAttributeCenterY
                                                          relatedBy:NSLayoutRelationEqual
                                                             toItem:topIsland
                                                          attribute:NSLayoutAttributeCenterY
                                                         multiplier:1
                                                           constant:0]];

    // --- middle island: checklist (left) + output (right) ---
    // IMPORTANT: build BOTH text views via the same helper. A bare
    // [[NSTextView alloc] init] has a zero-size frame, so its text container has
    // zero width and NOTHING lays out — that was why the checklist kept showing
    // up empty.
    NSScrollView* timelineScroll = nil;
    _timelineView = [self makeTextViewInScroll:&timelineScroll editable:NO];

    NSScrollView* chatScroll = nil;
    _chatView = [self makeTextViewInScroll:&chatScroll editable:NO];
    _chatScroll = chatScroll;

    // Draggable divider: an NSSplitView lets you drag the boundary between the
    // checklist (left) and output (right) to give either pane more room.
    _split = [[NSSplitView alloc] initWithFrame:NSZeroRect];
    _split.translatesAutoresizingMaskIntoConstraints = NO;
    _split.vertical = YES;  // vertical divider -> panes side by side
    _split.dividerStyle = NSSplitViewDividerStyleThin;
    _split.delegate = self;
    [_split addArrangedSubview:timelineScroll];
    [_split addArrangedSubview:chatScroll];
    [midIsland addSubview:_split];
    NSDictionary* mid = @{ @"split" : _split };
    [midIsland addConstraints:[NSLayoutConstraint constraintsWithVisualFormat:@"H:|-8-[split]-8-|"
                                                                     options:0 metrics:nil views:mid]];
    [midIsland addConstraints:[NSLayoutConstraint constraintsWithVisualFormat:@"V:|-6-[split]-6-|"
                                                                     options:0 metrics:nil views:mid]];

    // --- input island: prompt + Inspect ---
    _promptField = [[NSTextField alloc] init];
    _promptField.translatesAutoresizingMaskIntoConstraints = NO;
    _promptField.placeholderString = @"Describe your model / what to review…";
    _promptField.font = [NSFont systemFontOfSize:13];
    _promptField.bezelStyle = NSTextFieldRoundedBezel;
    _promptField.target = self;
    _promptField.action = @selector(onSend:);

    _sendButton = [NSButton buttonWithTitle:@"Inspect" target:self action:@selector(onSend:)];
    _sendButton.bezelStyle = NSBezelStyleRounded;
    _sendButton.keyEquivalent = @"\r";
    _sendButton.translatesAutoresizingMaskIntoConstraints = NO;

    [inputIsland addSubview:_promptField];
    [inputIsland addSubview:_sendButton];
    NSDictionary* in = @{ @"prompt" : _promptField, @"send" : _sendButton };
    [inputIsland addConstraints:[NSLayoutConstraint
                                    constraintsWithVisualFormat:@"H:|-8-[prompt]-6-[send(76)]-8-|"
                                                        options:NSLayoutFormatAlignAllCenterY
                                                        metrics:nil
                                                          views:in]];
    [inputIsland addConstraint:[NSLayoutConstraint constraintWithItem:_promptField
                                                           attribute:NSLayoutAttributeCenterY
                                                           relatedBy:NSLayoutRelationEqual
                                                              toItem:inputIsland
                                                           attribute:NSLayoutAttributeCenterY
                                                          multiplier:1
                                                            constant:0]];

    // --- stack the islands vertically with tight gaps ---
    for (NSView* v in @[ topIsland, midIsland, inputIsland ]) [root addSubview:v];
    NSDictionary* islands = @{ @"top" : topIsland, @"mid" : midIsland, @"input" : inputIsland };
    for (NSString* fmt in @[ @"H:|-8-[top]-8-|", @"H:|-8-[mid]-8-|", @"H:|-8-[input]-8-|" ]) {
        [root addConstraints:[NSLayoutConstraint constraintsWithVisualFormat:fmt
                                                                     options:0
                                                                     metrics:nil
                                                                       views:islands]];
    }
    [root addConstraints:[NSLayoutConstraint
                             constraintsWithVisualFormat:@"V:|-8-[top(34)]-6-[mid(>=180)]-6-[input(42)]-8-|"
                                                 options:0
                                                 metrics:nil
                                                   views:islands]];

    _timelineActive = -1;
    _timelineReached = -1;
    [self renderTimeline];
    [self refreshPermissions];
    [self refreshWindowList];

    [self appendChat:@"Describe your model in the box below, then press Inspect."
               color:[NSColor secondaryLabelColor] bold:NO];

    _window.delegate = self;
    [self positionInCorner];
    [NSApp activateIgnoringOtherApps:YES];
    [_window makeKeyAndOrderFront:nil];
    SessionLog(@"window shown and made key");

    // AppKit collapses the window to the content's fitting size on first
    // display; re-assert the intended size once the run loop has laid out, then
    // place the checklist/output divider.
    dispatch_async(dispatch_get_main_queue(), ^{
        [self positionInCorner];
        [self->_split setPosition:196 ofDividerAtIndex:0];  // default checklist width
    });
}

// Keep both split panes usable — neither collapses below ~120px.
- (CGFloat)splitView:(NSSplitView*)splitView
    constrainMinCoordinate:(CGFloat)proposedMin
               ofSubviewAt:(NSInteger)dividerIndex {
    return 120;
}
- (CGFloat)splitView:(NSSplitView*)splitView
    constrainMaxCoordinate:(CGFloat)proposedMax
               ofSubviewAt:(NSInteger)dividerIndex {
    return NSWidth(splitView.bounds) - 140;
}

// A SOLID (fully opaque) rounded dark card. The window is transparent, so each
// of these floats as its own independent card over the CAD app.
+ (NSView*)makeIsland {
    NSView* v = [[NSView alloc] init];
    v.translatesAutoresizingMaskIntoConstraints = NO;
    v.wantsLayer = YES;
    v.layer.cornerRadius = 11;
    v.layer.backgroundColor = [NSColor colorWithRed:0.13 green:0.13 blue:0.15 alpha:1.0].CGColor;
    v.layer.borderWidth = 1;
    v.layer.borderColor = [NSColor colorWithWhite:1.0 alpha:0.10].CGColor;
    // Drop shadow so each solid card reads as floating above the CAD app.
    v.layer.shadowColor = [NSColor blackColor].CGColor;
    v.layer.shadowOpacity = 0.35;
    v.layer.shadowRadius = 8;
    v.layer.shadowOffset = NSMakeSize(0, -2);
    v.layer.masksToBounds = NO;
    return v;
}

// Positions the overlay in the bottom-right corner at its intended size. Uses
// an EXPLICIT size (not the current frame) because AppKit collapses the window
// to the content's fitting size on first display; re-asserting the size here
// (and again after display) keeps it correct.
- (void)positionInCorner {
    NSRect vf = (_window.screen ?: NSScreen.mainScreen).visibleFrame;
    const CGFloat margin = 18;
    const CGFloat w = 680, h = 383;  // 16:9
    NSRect f = NSMakeRect(NSMaxX(vf) - w - margin, NSMinY(vf) + margin, w, h);
    [_window setFrame:f display:YES];
}

- (void)windowWillClose:(NSNotification*)note {
    SessionLog(@"windowWillClose — app will terminate after last window closes");
}

- (void)applicationWillTerminate:(NSNotification*)note {
    SessionLog(@"applicationWillTerminate");
}

- (void)onRefresh:(id)sender {
    [self refreshPermissions];
    [self refreshWindowList];
}

- (void)onQuit:(id)sender {
    [NSApp terminate:nil];
}

// -------------------------------------------------------------- inspection --

- (BOOL)resolveWindow:(WindowInfo*)out explanation:(std::string*)why {
    NSInteger sel = _windowPicker.indexOfSelectedItem;
    if (sel == 1) {  // explicit full-screen
        *out = cadgod::platform::mainScreenWindow();
        *why = "full-screen capture selected by user";
        return YES;
    }
    if (sel >= 2 && sel - 2 < (NSInteger)_pickerWindows.size()) {
        *out = _pickerWindows[(std::size_t)(sel - 2)];
        *why = "window selected manually";
        return YES;
    }
    try {
        *out = cadgod::app::resolveTargetWindow(*why);
        return YES;
    } catch (const std::exception& e) {
        *why = e.what();
        return NO;
    }
}

- (void)onSend:(id)sender {
    if (_running) return;
    NSString* promptNS = [_promptField.stringValue
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    std::string prompt = promptNS.UTF8String ? promptNS.UTF8String : "";
    _promptField.stringValue = @"";

    [self appendChat:[NSString stringWithFormat:@"\n❯ %@", promptNS.length ? promptNS : @"(inspect)"]
               color:[NSColor systemTealColor] bold:YES];

    _running = YES;
    _timelineFailed = NO;
    _timelineActive = 0;
    _timelineReached = 0;
    [self renderTimeline];
    _sendButton.enabled = NO;
    BOOL debugOn = (_debugToggle.state == NSControlStateValueOn);

    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        // Belt and suspenders: an ObjC NSException raised on this background
        // thread is NOT a std::exception (so inner C++ catches miss it) and is
        // NOT caught by NSSetUncaughtExceptionHandler (main-thread only) — it
        // would call abort() and kill the whole app. Catch everything here and
        // turn it into a visible error instead of a shutdown.
        @try {
            [self runInspectionWithPrompt:prompt debug:debugOn];
        } @catch (NSException* ex) {
            [self failWithMessage:[NSString stringWithFormat:@"Internal error (%@): %@ — the run "
                                                             @"stopped but the app is still up.",
                                                             ex.name, ex.reason]];
        } @catch (...) {
            [self failWithMessage:@"Unknown internal error — the run stopped but the app is "
                                  @"still up. See ~/Desktop/cadgod-session.log."];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            self->_sendButton.enabled = YES;
        });
        self->_running = NO;
        [self renderTimeline];
        SessionLog(@"===== run finished =====");
    });
}

- (void)runInspectionWithPrompt:(std::string)prompt debug:(BOOL)debugOn {
    namespace plat = cadgod::platform;
    SessionLog(@"===== run started =====");

    // ---- permissions gate: no permissions, no run --------------------------
    if (!plat::hasScreenRecordingPermission()) {
        plat::requestScreenRecordingPermission();
        if (!plat::hasScreenRecordingPermission()) {
            [self failWithMessage:@"Screen Recording permission missing. Grant it to this app "
                                  @"(or your terminal) in System Settings → Privacy & Security → "
                                  @"Screen Recording, then press ↻ and retry."];
            return;
        }
    }
    if (!plat::hasAccessibilityPermission(true)) {
        [self appendChat:@"⚠ Accessibility permission missing — camera orbit will not move the "
                         @"model. Screenshots still work. Grant it in System Settings → Privacy & "
                         @"Security → Accessibility."
                   color:[NSColor systemOrangeColor] bold:NO];
    }
    [self refreshPermissions];

    // ---- attach -------------------------------------------------------------
    [self refreshWindowList];
    WindowInfo target;
    std::string why;
    __block WindowInfo resolved;
    __block std::string resolvedWhy;
    __block BOOL ok = NO;
    dispatch_sync(dispatch_get_main_queue(), ^{
        WindowInfo w;
        std::string e;
        ok = [self resolveWindow:&w explanation:&e];
        resolved = w;
        resolvedWhy = e;
    });
    if (!ok) {
        [self failWithMessage:[NSString stringWithFormat:@"No valid target window: %@ — select a "
                                                         @"window manually from the picker.",
                                                         SafeStr(resolvedWhy)]];
        return;
    }
    target = resolved;
    why = resolvedWhy;

    NSString* attachText =
        [NSString stringWithFormat:@"Attached: %@ (window %u, %dx%d) — %@", SafeStr(target.app),
                                   target.id, target.width, target.height, SafeStr(why)];
    [self appendChat:attachText color:[NSColor secondaryLabelColor] bold:NO];
    [self setPhase:"attach"];

    // ---- config -------------------------------------------------------------
    InspectConfig cfg = cadgod::app::loadConfig();
    cfg.debug = debugOn;
    if (cfg.apiKey.empty()) {
        [self failWithMessage:@"ANTHROPIC_API_KEY is not set (put it in .env next to the binary). "
                              @"Refusing to run without the API — no fake data."];
        return;
    }

    // ---- events wiring -------------------------------------------------------
    cadgod::SessionEvents events;
    events.onState = [self](const std::string& phase, const std::string& detail) {
        [self setPhase:phase];
        NSColor* color = (phase == "engineering" || phase == "verify")
                             ? [NSColor systemPurpleColor]
                             : [NSColor labelColor];
        [self appendChat:[NSString stringWithFormat:@"  [%@] %@", SafeStr(phase), SafeStr(detail)]
                   color:color bold:NO];
    };
    events.onScreenshot = [self](const std::string& id, const std::string& path,
                                 const std::string& view) {
        NSDateFormatter* fmt = [[NSDateFormatter alloc] init];
        fmt.dateFormat = @"HH:mm:ss";
        NSString* ts = [fmt stringFromDate:[NSDate date]];
        [self appendChatImage:SafeStr(path)
                      caption:[NSString stringWithFormat:@"  %@ — view '%@' @ %@", SafeStr(id),
                                                         SafeStr(view), ts]];
    };
    events.onVisionNotes = [self](const std::string& id, const std::string& notes) {
        [self appendChat:[NSString stringWithFormat:@"  👁 %@: %@", SafeStr(id), SafeStr(notes)]
                   color:[NSColor systemYellowColor] bold:NO];
    };
    events.onLog = [self](const std::string& line) {
        [self appendChat:[NSString stringWithFormat:@"  %@", SafeStr(line)]
                   color:[NSColor secondaryLabelColor] bold:NO];
    };
    events.askUser = [self](const std::string& question, const std::vector<std::string>& options) {
        return [self askUserModal:question options:options];
    };

    // ---- run ------------------------------------------------------------------
    try {
        cadgod::Report report = cadgod::app::runInspection(target, cfg, prompt, events);
        [self appendChat:@"" color:[NSColor labelColor] bold:NO];
        [self appendMarkdown:SafeStr(report.toMarkdown())];  // rendered, not raw ##/**
        [self setPhase:"done"];
    } catch (const std::exception& e) {
        [self failWithMessage:[NSString stringWithFormat:@"INSPECTION ABORTED: %@",
                                                         SafeStr(e.what() ? e.what() : "")]];
    }
}

- (void)failWithMessage:(NSString*)message {
    dispatch_async(dispatch_get_main_queue(), ^{
        self->_timelineFailed = YES;
        [self renderTimeline];
    });
    [self appendChat:[NSString stringWithFormat:@"✗ %@", message ?: @"(unknown error)"]
               color:[NSColor systemRedColor] bold:YES];
}

// Blocking modal question — called from the worker thread.
- (std::string)askUserModal:(const std::string&)question
                    options:(const std::vector<std::string>&)options {
    __block std::string answer;
    dispatch_sync(dispatch_get_main_queue(), ^{
        NSAlert* alert = [[NSAlert alloc] init];
        alert.messageText = @"CADGOD needs clarification";
        alert.informativeText = SafeStr(question);

        NSStackView* stack = [[NSStackView alloc] initWithFrame:NSMakeRect(0, 0, 280, 58)];
        stack.orientation = NSUserInterfaceLayoutOrientationVertical;
        stack.alignment = NSLayoutAttributeLeading;
        NSPopUpButton* popup = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(0, 0, 280, 26)];
        for (const auto& opt : options) {
            [popup addItemWithTitle:SafeStr(opt)];
        }
        NSTextField* other = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 280, 24)];
        other.placeholderString = @"Or type your own answer…";
        [stack addArrangedSubview:popup];
        [stack addArrangedSubview:other];
        alert.accessoryView = stack;
        [alert addButtonWithTitle:@"Submit"];

        [alert runModal];
        NSString* typed = [other.stringValue
            stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        NSString* chosen = typed.length ? typed : popup.titleOfSelectedItem;
        answer = chosen.UTF8String ? chosen.UTF8String : "";
    });
    return answer;
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)app {
    return YES;
}

@end

// Crash diagnostics: write a stack trace to ~/Desktop/cadgod-crash.log so a
// crash is never silent. If the app still dies, this file has the real cause.
// The path is resolved ONCE at startup into a plain C buffer, because a signal
// handler must not call NSString / tilde-expansion (not async-signal-safe — the
// previous version crashed inside its own handler before it could log).
static char g_crashLogPath[1024] = {0};

static NSString* crashLogPath() {
    return [@"~/Desktop/cadgod-crash.log" stringByExpandingTildeInPath];
}

static void handleUncaughtException(NSException* ex) {
    NSMutableString* log = [NSMutableString string];
    [log appendFormat:@"CADGOD crashed (exception) at %@\n", [NSDate date]];
    [log appendFormat:@"%@: %@\n\n", ex.name, ex.reason];
    for (NSString* frame in ex.callStackSymbols) [log appendFormat:@"%@\n", frame];
    [log writeToFile:crashLogPath() atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

static void handleCrashSignal(int sig) {
    // Async-signal-safe only: no Objective-C, no malloc-heavy calls.
    int fd = open(g_crashLogPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd >= 0) {
        char hdr[64];
        int n = snprintf(hdr, sizeof hdr, "CADGOD crashed (signal %d)\n", sig);
        if (n > 0) write(fd, hdr, (size_t)n);
        void* cb[64];
        int frames = backtrace(cb, 64);
        backtrace_symbols_fd(cb, frames, fd);
        close(fd);
    }
    signal(sig, SIG_DFL);
    raise(sig);
}

static void installCrashHandlers() {
    strncpy(g_crashLogPath, crashLogPath().fileSystemRepresentation, sizeof(g_crashLogPath) - 1);
    NSSetUncaughtExceptionHandler(&handleUncaughtException);
    for (int sig : {SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE}) signal(sig, handleCrashSignal);
}

// NSApplication subclass that wraps event dispatch in @try/@catch. Every
// keystroke, click, menu action and — importantly — every paste flows through
// -sendEvent:/-sendAction:. Guarding here means an AppKit exception raised while
// handling any of them (e.g. a paste hitting an edge case) is logged and the
// app keeps running, instead of aborting. This is the global safeguard.
@interface CadgodApplication : NSApplication
@end

@implementation CadgodApplication
- (void)sendEvent:(NSEvent*)event {
    @try {
        [super sendEvent:event];
    } @catch (NSException* ex) {
        SessionLog([NSString stringWithFormat:@"sendEvent EXCEPTION (%@): %@", ex.name, ex.reason]);
    }
}

- (BOOL)sendAction:(SEL)action to:(id)target from:(id)sender {
    @try {
        return [super sendAction:action to:target from:sender];
    } @catch (NSException* ex) {
        SessionLog([NSString stringWithFormat:@"sendAction EXCEPTION (%@): %@", ex.name, ex.reason]);
        return NO;
    }
}

- (void)reportException:(NSException*)exception {
    SessionLog([NSString stringWithFormat:@"reportException: %@ — %@", exception.name,
                                          exception.reason]);
}
@end

// Builds a minimal main menu. An accessory app shows no menu bar, but Cocoa
// still routes Cmd-key equivalents (Copy/Paste/Cut/Select-All/Undo) THROUGH the
// main menu — with no menu, those shortcuts never reach text fields. This is
// what makes ⌘C / ⌘V / ⌘X / ⌘A work in the prompt input.
static void installMainMenu(NSApplication* app) {
    NSMenu* mainMenu = [[NSMenu alloc] init];

    NSMenuItem* appItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:appItem];
    NSMenu* appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:@"Quit CADGOD" action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = appMenu;

    NSMenuItem* editItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:editItem];
    NSMenu* editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
    NSMenuItem* redo = [editMenu addItemWithTitle:@"Redo"
                                           action:@selector(redo:)
                                    keyEquivalent:@"Z"];
    redo.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    editItem.submenu = editMenu;

    app.mainMenu = mainMenu;
}

int main(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--self-test") return 0;
    }
    installCrashHandlers();
    @autoreleasepool {
        // Instantiate our guarded NSApplication subclass as the shared app.
        NSApplication* app = [CadgodApplication sharedApplication];
        installMainMenu(app);
        // Accessory: no Dock icon, no app-switcher focus stealing — behaves as
        // a true overlay panel that floats above whatever app (e.g. the CAD
        // app / browser) is actually frontmost.
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        CadgodOverlay* delegate = [[CadgodOverlay alloc] init];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}

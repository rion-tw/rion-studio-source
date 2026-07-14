#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

namespace rion::window_frame {

constexpr int kProtocolVersion = 1;
constexpr int kMaxAlignmentAttempts = 3;
constexpr int kMaxRestorePolls = 10;

struct Rect {
  std::int32_t left = 0;
  std::int32_t top = 0;
  std::int32_t right = 0;
  std::int32_t bottom = 0;
};

struct Bounds {
  std::int32_t x = 0;
  std::int32_t y = 0;
  std::int32_t width = 0;
  std::int32_t height = 0;
};

struct FrameMeasurement {
  Rect outer;
  Rect visible;
};

bool IsValidRect(const Rect& rect);
bool RectsEqual(const Rect& left, const Rect& right);
bool TryMakeRect(const Bounds& bounds, Rect* rect);
bool TryComputeAdjustedOuter(const FrameMeasurement& current,
                             const Rect& target_visible,
                             Rect* adjusted_outer);

struct CandidateMetadata {
  Rect visible;
  bool is_chrome_widget = false;
  bool is_ownerless = false;
};

enum class CandidateSelectionStatus {
  kNone,
  kSelected,
  kAmbiguous,
};

struct CandidateSelection {
  CandidateSelectionStatus status = CandidateSelectionStatus::kNone;
  std::size_t index = 0;
};

CandidateSelection SelectBestCandidate(
    const std::vector<CandidateMetadata>& candidates,
    const Rect& target_visible);

enum class WindowRestoreState {
  kNormal,
  kNeedsRestore,
  kGone,
};

enum class WindowRestoreFailure {
  kNone,
  kRequestFailed,
  kWindowDisappeared,
  kTimedOut,
};

struct WindowRestoreCallbacks {
  std::function<WindowRestoreState()> query_state;
  std::function<bool()> request_restore;
  std::function<void()> wait_for_next_poll;
};

struct WindowRestoreResult {
  bool success = false;
  bool requested = false;
  int polls = 0;
  WindowRestoreFailure failure = WindowRestoreFailure::kNone;
};

WindowRestoreResult EnsureWindowRestored(
    const WindowRestoreCallbacks& callbacks,
    int max_polls = kMaxRestorePolls);

enum class AlignmentFailure {
  kNone,
  kMeasurementFailed,
  kInvalidMeasurement,
  kGeometryOverflow,
  kApplyFailed,
  kFlushFailed,
  kExhausted,
};

struct AlignmentCallbacks {
  std::function<bool(FrameMeasurement*)> measure;
  std::function<bool(const Rect&)> apply_outer;
  std::function<bool()> flush;
};

struct AlignmentResult {
  bool success = false;
  AlignmentFailure failure = AlignmentFailure::kNone;
  bool has_before = false;
  bool has_after = false;
  FrameMeasurement before;
  FrameMeasurement after;
  int attempts = 0;
};

AlignmentResult AlignVisibleFrame(const Rect& target_visible,
                                  const AlignmentCallbacks& callbacks);

}  // namespace rion::window_frame

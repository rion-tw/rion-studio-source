#include "window_frame_logic.h"

#include <algorithm>
#include <limits>
#include <tuple>

namespace rion::window_frame {
namespace {

bool FitsInt32(std::int64_t value) {
  return value >= std::numeric_limits<std::int32_t>::min() &&
         value <= std::numeric_limits<std::int32_t>::max();
}

bool TryAdd(std::int32_t base, std::int64_t delta, std::int32_t* result) {
  const std::int64_t value = static_cast<std::int64_t>(base) + delta;
  if (!FitsInt32(value)) {
    return false;
  }
  *result = static_cast<std::int32_t>(value);
  return true;
}

std::int64_t IntersectionArea(const Rect& left, const Rect& right) {
  const std::int64_t width = std::max<std::int64_t>(
      0, static_cast<std::int64_t>(std::min(left.right, right.right)) -
             std::max(left.left, right.left));
  const std::int64_t height = std::max<std::int64_t>(
      0, static_cast<std::int64_t>(std::min(left.bottom, right.bottom)) -
             std::max(left.top, right.top));
  return width * height;
}

using CandidateRank = std::tuple<std::int64_t, bool, bool>;

CandidateRank RankCandidate(const CandidateMetadata& candidate,
                            const Rect& target_visible) {
  return {IntersectionArea(candidate.visible, target_visible),
          candidate.is_chrome_widget, candidate.is_ownerless};
}

}  // namespace

bool IsValidRect(const Rect& rect) {
  const std::int64_t width =
      static_cast<std::int64_t>(rect.right) - rect.left;
  const std::int64_t height =
      static_cast<std::int64_t>(rect.bottom) - rect.top;
  return width > 0 && height > 0 &&
         width <= std::numeric_limits<std::int32_t>::max() &&
         height <= std::numeric_limits<std::int32_t>::max();
}

bool RectsEqual(const Rect& left, const Rect& right) {
  return left.left == right.left && left.top == right.top &&
         left.right == right.right && left.bottom == right.bottom;
}

bool TryMakeRect(const Bounds& bounds, Rect* rect) {
  if (rect == nullptr || bounds.width <= 0 || bounds.height <= 0) {
    return false;
  }

  const std::int64_t right =
      static_cast<std::int64_t>(bounds.x) + bounds.width;
  const std::int64_t bottom =
      static_cast<std::int64_t>(bounds.y) + bounds.height;
  if (!FitsInt32(right) || !FitsInt32(bottom)) {
    return false;
  }

  *rect = {bounds.x, bounds.y, static_cast<std::int32_t>(right),
           static_cast<std::int32_t>(bottom)};
  return IsValidRect(*rect);
}

bool TryComputeAdjustedOuter(const FrameMeasurement& current,
                             const Rect& target_visible,
                             Rect* adjusted_outer) {
  if (adjusted_outer == nullptr || !IsValidRect(current.outer) ||
      !IsValidRect(current.visible) || !IsValidRect(target_visible)) {
    return false;
  }

  Rect result;
  if (!TryAdd(current.outer.left,
              static_cast<std::int64_t>(target_visible.left) -
                  current.visible.left,
              &result.left) ||
      !TryAdd(current.outer.top,
              static_cast<std::int64_t>(target_visible.top) -
                  current.visible.top,
              &result.top) ||
      !TryAdd(current.outer.right,
              static_cast<std::int64_t>(target_visible.right) -
                  current.visible.right,
              &result.right) ||
      !TryAdd(current.outer.bottom,
              static_cast<std::int64_t>(target_visible.bottom) -
                  current.visible.bottom,
              &result.bottom) ||
      !IsValidRect(result)) {
    return false;
  }

  *adjusted_outer = result;
  return true;
}

CandidateSelection SelectBestCandidate(
    const std::vector<CandidateMetadata>& candidates,
    const Rect& target_visible) {
  CandidateSelection selection;
  CandidateRank best_rank;
  bool found = false;
  bool ambiguous = false;

  if (!IsValidRect(target_visible)) {
    return selection;
  }

  for (std::size_t index = 0; index < candidates.size(); ++index) {
    const CandidateMetadata& candidate = candidates[index];
    if (!IsValidRect(candidate.visible)) {
      continue;
    }

    const CandidateRank rank = RankCandidate(candidate, target_visible);
    if (!found || rank > best_rank) {
      found = true;
      ambiguous = false;
      best_rank = rank;
      selection.index = index;
    } else if (rank == best_rank) {
      ambiguous = true;
    }
  }

  if (!found) {
    selection.status = CandidateSelectionStatus::kNone;
  } else if (ambiguous) {
    selection.status = CandidateSelectionStatus::kAmbiguous;
  } else {
    selection.status = CandidateSelectionStatus::kSelected;
  }
  return selection;
}

WindowRestoreResult EnsureWindowRestored(
    const WindowRestoreCallbacks& callbacks,
    int max_polls) {
  WindowRestoreResult result;
  if (!callbacks.query_state || !callbacks.request_restore ||
      !callbacks.wait_for_next_poll || max_polls <= 0) {
    result.failure = WindowRestoreFailure::kRequestFailed;
    return result;
  }

  const WindowRestoreState initial_state = callbacks.query_state();
  if (initial_state == WindowRestoreState::kGone) {
    result.failure = WindowRestoreFailure::kWindowDisappeared;
    return result;
  }
  if (initial_state == WindowRestoreState::kNormal) {
    result.success = true;
    return result;
  }

  result.requested = true;
  if (!callbacks.request_restore()) {
    result.failure = WindowRestoreFailure::kRequestFailed;
    return result;
  }

  for (int poll = 1; poll <= max_polls; ++poll) {
    callbacks.wait_for_next_poll();
    result.polls = poll;

    const WindowRestoreState state = callbacks.query_state();
    if (state == WindowRestoreState::kGone) {
      result.failure = WindowRestoreFailure::kWindowDisappeared;
      return result;
    }
    if (state == WindowRestoreState::kNormal) {
      result.success = true;
      return result;
    }
  }

  result.failure = WindowRestoreFailure::kTimedOut;
  return result;
}

AlignmentResult AlignVisibleFrame(const Rect& target_visible,
                                  const AlignmentCallbacks& callbacks) {
  AlignmentResult result;
  if (!IsValidRect(target_visible) || !callbacks.measure ||
      !callbacks.apply_outer || !callbacks.flush) {
    result.failure = AlignmentFailure::kInvalidMeasurement;
    return result;
  }

  FrameMeasurement current;
  if (!callbacks.measure(&current)) {
    result.failure = AlignmentFailure::kMeasurementFailed;
    return result;
  }
  if (!IsValidRect(current.outer) || !IsValidRect(current.visible)) {
    result.failure = AlignmentFailure::kInvalidMeasurement;
    return result;
  }

  result.before = current;
  result.after = current;
  result.has_before = true;
  result.has_after = true;
  if (RectsEqual(current.visible, target_visible)) {
    result.success = true;
    return result;
  }

  for (int attempt = 1; attempt <= kMaxAlignmentAttempts; ++attempt) {
    Rect adjusted_outer;
    if (!TryComputeAdjustedOuter(current, target_visible, &adjusted_outer)) {
      result.failure = AlignmentFailure::kGeometryOverflow;
      return result;
    }

    result.attempts = attempt;
    if (!callbacks.apply_outer(adjusted_outer)) {
      result.failure = AlignmentFailure::kApplyFailed;
      return result;
    }
    if (!callbacks.flush()) {
      result.failure = AlignmentFailure::kFlushFailed;
      return result;
    }
    if (!callbacks.measure(&current)) {
      result.failure = AlignmentFailure::kMeasurementFailed;
      return result;
    }
    if (!IsValidRect(current.outer) || !IsValidRect(current.visible)) {
      result.failure = AlignmentFailure::kInvalidMeasurement;
      return result;
    }

    result.after = current;
    result.has_after = true;
    if (RectsEqual(current.visible, target_visible)) {
      result.success = true;
      result.failure = AlignmentFailure::kNone;
      return result;
    }
  }

  result.failure = AlignmentFailure::kExhausted;
  return result;
}

}  // namespace rion::window_frame

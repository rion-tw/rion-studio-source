#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

#include "window_frame_logic.h"

namespace {

using rion::window_frame::AlignmentCallbacks;
using rion::window_frame::AlignmentFailure;
using rion::window_frame::Bounds;
using rion::window_frame::CandidateMetadata;
using rion::window_frame::CandidateSelectionStatus;
using rion::window_frame::FrameMeasurement;
using rion::window_frame::Rect;
using rion::window_frame::WindowRestoreCallbacks;
using rion::window_frame::WindowRestoreFailure;
using rion::window_frame::WindowRestoreState;

int g_failures = 0;

void Fail(const char* expression, const char* file, int line) {
  std::cerr << file << ':' << line << ": expectation failed: " << expression
            << '\n';
  ++g_failures;
}

#define EXPECT_TRUE(expression)                                                \
  do {                                                                         \
    if (!(expression)) {                                                       \
      Fail(#expression, __FILE__, __LINE__);                                   \
    }                                                                          \
  } while (false)

#define EXPECT_EQ(left, right)                                                 \
  do {                                                                         \
    if (!((left) == (right))) {                                                \
      Fail(#left " == " #right, __FILE__, __LINE__);                          \
    }                                                                          \
  } while (false)

bool SameRect(const Rect& left, const Rect& right) {
  return rion::window_frame::RectsEqual(left, right);
}

void TestAlreadyAlignedDoesNotMove() {
  const Rect target = {10, 20, 310, 220};
  const FrameMeasurement measurement = {{2, 12, 318, 228}, target};
  int apply_count = 0;
  int flush_count = 0;

  AlignmentCallbacks callbacks;
  callbacks.measure = [&](FrameMeasurement* output) {
    *output = measurement;
    return true;
  };
  callbacks.apply_outer = [&](const Rect&) {
    ++apply_count;
    return true;
  };
  callbacks.flush = [&] {
    ++flush_count;
    return true;
  };

  const auto result =
      rion::window_frame::AlignVisibleFrame(target, callbacks);
  EXPECT_TRUE(result.success);
  EXPECT_EQ(result.attempts, 0);
  EXPECT_EQ(apply_count, 0);
  EXPECT_EQ(flush_count, 0);
  EXPECT_TRUE(SameRect(result.after.visible, target));
}

void TestAsymmetricFrameCorrection() {
  const FrameMeasurement current = {
      {-8, -2, 108, 110},
      {0, 0, 100, 100},
  };
  const Rect target = {100, 200, 400, 600};
  Rect adjusted;
  EXPECT_TRUE(rion::window_frame::TryComputeAdjustedOuter(current, target,
                                                           &adjusted));
  EXPECT_TRUE(SameRect(adjusted, {92, 198, 408, 610}));
}

void TestNegativeCoordinates() {
  const FrameMeasurement current = {
      {-1930, -10, -910, 1090},
      {-1920, 0, -920, 1080},
  };
  const Rect target = {-2560, -400, -1280, 320};
  Rect adjusted;
  EXPECT_TRUE(rion::window_frame::TryComputeAdjustedOuter(current, target,
                                                           &adjusted));
  EXPECT_TRUE(SameRect(adjusted, {-2570, -410, -1270, 330}));
}

void TestGeometryOverflowIsRejected() {
  const std::int32_t maximum = std::numeric_limits<std::int32_t>::max();
  const FrameMeasurement current = {
      {maximum - 100, 0, maximum, 100},
      {0, 0, 100, 100},
  };
  const Rect target = {1000, 0, 1100, 100};
  Rect adjusted;
  EXPECT_TRUE(!rion::window_frame::TryComputeAdjustedOuter(current, target,
                                                            &adjusted));

  Rect converted;
  EXPECT_TRUE(!rion::window_frame::TryMakeRect(
      {maximum - 5, 0, 10, 10}, &converted));
}

void TestCandidateSelectionUsesIntersectionThenTieBreaks() {
  const Rect target = {0, 0, 100, 100};
  std::vector<CandidateMetadata> candidates = {
      {{500, 500, 600, 600}, true, true},
      {{25, 25, 75, 75}, false, false},
  };
  auto selected =
      rion::window_frame::SelectBestCandidate(candidates, target);
  EXPECT_EQ(selected.status, CandidateSelectionStatus::kSelected);
  EXPECT_EQ(selected.index, static_cast<std::size_t>(1));

  candidates = {
      {{0, 0, 50, 50}, false, true},
      {{50, 50, 100, 100}, true, false},
  };
  selected = rion::window_frame::SelectBestCandidate(candidates, target);
  EXPECT_EQ(selected.status, CandidateSelectionStatus::kSelected);
  EXPECT_EQ(selected.index, static_cast<std::size_t>(1));

  candidates = {
      {{0, 0, 50, 50}, true, false},
      {{50, 50, 100, 100}, true, true},
  };
  selected = rion::window_frame::SelectBestCandidate(candidates, target);
  EXPECT_EQ(selected.status, CandidateSelectionStatus::kSelected);
  EXPECT_EQ(selected.index, static_cast<std::size_t>(1));
}

void TestCandidateAmbiguityIsRejected() {
  const Rect target = {0, 0, 100, 100};
  const std::vector<CandidateMetadata> candidates = {
      {{0, 0, 50, 50}, true, true},
      {{50, 50, 100, 100}, true, true},
  };
  const auto selected =
      rion::window_frame::SelectBestCandidate(candidates, target);
  EXPECT_EQ(selected.status, CandidateSelectionStatus::kAmbiguous);
}

void TestNormalWindowDoesNotRequestRestore() {
  int request_count = 0;
  int wait_count = 0;
  WindowRestoreCallbacks callbacks;
  callbacks.query_state = [] { return WindowRestoreState::kNormal; };
  callbacks.request_restore = [&] {
    ++request_count;
    return true;
  };
  callbacks.wait_for_next_poll = [&] { ++wait_count; };

  const auto result = rion::window_frame::EnsureWindowRestored(callbacks);
  EXPECT_TRUE(result.success);
  EXPECT_TRUE(!result.requested);
  EXPECT_EQ(result.polls, 0);
  EXPECT_EQ(request_count, 0);
  EXPECT_EQ(wait_count, 0);
}

void TestZoomedWindowRestoresWithinFinitePolls() {
  const std::vector<WindowRestoreState> states = {
      WindowRestoreState::kNeedsRestore,
      WindowRestoreState::kNeedsRestore,
      WindowRestoreState::kNormal,
  };
  std::size_t state_index = 0;
  int request_count = 0;
  int wait_count = 0;
  WindowRestoreCallbacks callbacks;
  callbacks.query_state = [&] { return states[state_index++]; };
  callbacks.request_restore = [&] {
    ++request_count;
    return true;
  };
  callbacks.wait_for_next_poll = [&] { ++wait_count; };

  const auto result = rion::window_frame::EnsureWindowRestored(callbacks, 3);
  EXPECT_TRUE(result.success);
  EXPECT_TRUE(result.requested);
  EXPECT_EQ(result.polls, 2);
  EXPECT_EQ(request_count, 1);
  EXPECT_EQ(wait_count, 2);
}

void TestRestoreReportsDisappearedWindow() {
  int state_index = 0;
  WindowRestoreCallbacks callbacks;
  callbacks.query_state = [&] {
    return state_index++ == 0 ? WindowRestoreState::kNeedsRestore
                              : WindowRestoreState::kGone;
  };
  callbacks.request_restore = [] { return true; };
  callbacks.wait_for_next_poll = [] {};

  const auto result = rion::window_frame::EnsureWindowRestored(callbacks, 3);
  EXPECT_TRUE(!result.success);
  EXPECT_EQ(result.failure, WindowRestoreFailure::kWindowDisappeared);
  EXPECT_EQ(result.polls, 1);
}

void TestRestoreTimeoutIsBounded() {
  int query_count = 0;
  int wait_count = 0;
  WindowRestoreCallbacks callbacks;
  callbacks.query_state = [&] {
    ++query_count;
    return WindowRestoreState::kNeedsRestore;
  };
  callbacks.request_restore = [] { return true; };
  callbacks.wait_for_next_poll = [&] { ++wait_count; };

  const auto result = rion::window_frame::EnsureWindowRestored(callbacks, 3);
  EXPECT_TRUE(!result.success);
  EXPECT_EQ(result.failure, WindowRestoreFailure::kTimedOut);
  EXPECT_EQ(result.polls, 3);
  EXPECT_EQ(query_count, 4);
  EXPECT_EQ(wait_count, 3);
}

void TestRestoreRequestFailureIsReported() {
  WindowRestoreCallbacks callbacks;
  callbacks.query_state = [] { return WindowRestoreState::kNeedsRestore; };
  callbacks.request_restore = [] { return false; };
  callbacks.wait_for_next_poll = [] {};

  const auto result = rion::window_frame::EnsureWindowRestored(callbacks, 3);
  EXPECT_TRUE(!result.success);
  EXPECT_EQ(result.failure, WindowRestoreFailure::kRequestFailed);
  EXPECT_TRUE(result.requested);
  EXPECT_EQ(result.polls, 0);
}

void TestThreeResidualCorrectionsCanConverge() {
  const Rect target = {0, 0, 100, 100};
  const std::vector<FrameMeasurement> measurements = {
      {{-8, -8, 109, 108}, {0, 0, 101, 100}},
      {{-8, -8, 108, 109}, {0, 0, 100, 101}},
      {{-9, -8, 108, 108}, {-1, 0, 100, 100}},
      {{-8, -8, 108, 108}, target},
  };
  std::size_t measurement_index = 0;
  int apply_count = 0;
  int flush_count = 0;

  AlignmentCallbacks callbacks;
  callbacks.measure = [&](FrameMeasurement* output) {
    if (measurement_index >= measurements.size()) {
      return false;
    }
    *output = measurements[measurement_index++];
    return true;
  };
  callbacks.apply_outer = [&](const Rect&) {
    ++apply_count;
    return true;
  };
  callbacks.flush = [&] {
    ++flush_count;
    return true;
  };

  const auto result =
      rion::window_frame::AlignVisibleFrame(target, callbacks);
  EXPECT_TRUE(result.success);
  EXPECT_EQ(result.attempts, 3);
  EXPECT_EQ(apply_count, 3);
  EXPECT_EQ(flush_count, 3);
  EXPECT_TRUE(SameRect(result.after.visible, target));
}

void TestAlignmentStopsAfterThreeAttempts() {
  const Rect target = {0, 0, 100, 100};
  const FrameMeasurement stuck = {
      {-8, -8, 109, 108},
      {0, 0, 101, 100},
  };
  int apply_count = 0;

  AlignmentCallbacks callbacks;
  callbacks.measure = [&](FrameMeasurement* output) {
    *output = stuck;
    return true;
  };
  callbacks.apply_outer = [&](const Rect&) {
    ++apply_count;
    return true;
  };
  callbacks.flush = [] { return true; };

  const auto result =
      rion::window_frame::AlignVisibleFrame(target, callbacks);
  EXPECT_TRUE(!result.success);
  EXPECT_EQ(result.failure, AlignmentFailure::kExhausted);
  EXPECT_EQ(result.attempts, 3);
  EXPECT_EQ(apply_count, 3);
}

}  // namespace

int main() {
  TestAlreadyAlignedDoesNotMove();
  TestAsymmetricFrameCorrection();
  TestNegativeCoordinates();
  TestGeometryOverflowIsRejected();
  TestCandidateSelectionUsesIntersectionThenTieBreaks();
  TestCandidateAmbiguityIsRejected();
  TestNormalWindowDoesNotRequestRestore();
  TestZoomedWindowRestoresWithinFinitePolls();
  TestRestoreReportsDisappearedWindow();
  TestRestoreTimeoutIsBounded();
  TestRestoreRequestFailureIsReported();
  TestThreeResidualCorrectionsCanConverge();
  TestAlignmentStopsAfterThreeAttempts();

  if (g_failures != 0) {
    std::cerr << g_failures << " test expectation(s) failed\n";
    return 1;
  }
  std::cout << "window frame helper logic tests passed\n";
  return 0;
}

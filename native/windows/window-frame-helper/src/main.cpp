#include <windows.h>
#include <dwmapi.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cwchar>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <limits>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "window_frame_logic.h"

namespace {

using rion::window_frame::AlignmentCallbacks;
using rion::window_frame::AlignmentFailure;
using rion::window_frame::AlignmentResult;
using rion::window_frame::Bounds;
using rion::window_frame::CandidateMetadata;
using rion::window_frame::CandidateSelectionStatus;
using rion::window_frame::FrameMeasurement;
using rion::window_frame::Rect;
using rion::window_frame::WindowRestoreCallbacks;
using rion::window_frame::WindowRestoreFailure;
using rion::window_frame::WindowRestoreState;

constexpr wchar_t kAlignCommand[] = L"align-visible-frame";
constexpr wchar_t kChromeClassPrefix[] = L"Chrome_WidgetWin_";
constexpr std::chrono::milliseconds kWindowWaitTimeout(1500);
constexpr std::chrono::milliseconds kWindowPollInterval(50);
constexpr std::chrono::milliseconds kRestorePollInterval(50);

enum ExitCode : int {
  kExitSuccess = 0,
  kExitInvalidArguments = 2,
  kExitWindowNotFound = 3,
  kExitAmbiguousWindow = 4,
  kExitFrameQueryFailed = 5,
  kExitSetWindowFailed = 6,
  kExitDwmFlushFailed = 7,
  kExitAlignmentFailed = 8,
  kExitRestoreFailed = 9,
};

struct Options {
  DWORD pid = 0;
  Bounds target;
};

struct WindowCandidate {
  HWND hwnd = nullptr;
  FrameMeasurement measurement;
  CandidateMetadata metadata;
};

enum class FindWindowStatus {
  kFound,
  kNotFound,
  kAmbiguous,
};

struct FindWindowResult {
  FindWindowStatus status = FindWindowStatus::kNotFound;
  WindowCandidate candidate;
};

std::int32_t ToInt32(LONG value) {
  return static_cast<std::int32_t>(value);
}

Rect ToRect(const RECT& rect) {
  return {ToInt32(rect.left), ToInt32(rect.top), ToInt32(rect.right),
          ToInt32(rect.bottom)};
}

bool MeasureWindow(HWND hwnd, FrameMeasurement* measurement) {
  if (measurement == nullptr || !IsWindow(hwnd)) {
    return false;
  }

  RECT outer = {};
  RECT visible = {};
  if (!GetWindowRect(hwnd, &outer) ||
      FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS,
                                   &visible,
                                   static_cast<DWORD>(sizeof(visible))))) {
    return false;
  }

  const FrameMeasurement result = {ToRect(outer), ToRect(visible)};
  if (!rion::window_frame::IsValidRect(result.outer) ||
      !rion::window_frame::IsValidRect(result.visible)) {
    return false;
  }
  *measurement = result;
  return true;
}

bool IsChromeWidgetClass(HWND hwnd) {
  wchar_t class_name[256] = {};
  const int length = GetClassNameW(hwnd, class_name,
                                   static_cast<int>(std::size(class_name)));
  if (length <= 0) {
    return false;
  }
  constexpr std::size_t prefix_length = std::size(kChromeClassPrefix) - 1;
  return static_cast<std::size_t>(length) >= prefix_length &&
         std::wcsncmp(class_name, kChromeClassPrefix, prefix_length) == 0;
}

struct EnumerationContext {
  DWORD pid = 0;
  std::vector<WindowCandidate>* candidates = nullptr;
};

BOOL CALLBACK CollectWindow(HWND hwnd, LPARAM parameter) {
  auto* context = reinterpret_cast<EnumerationContext*>(parameter);
  if (context == nullptr || context->candidates == nullptr ||
      !IsWindowVisible(hwnd) || IsIconic(hwnd)) {
    return TRUE;
  }

  DWORD window_pid = 0;
  GetWindowThreadProcessId(hwnd, &window_pid);
  if (window_pid != context->pid) {
    return TRUE;
  }

  DWORD cloaked = 0;
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked,
                                   static_cast<DWORD>(sizeof(cloaked)))) ||
      cloaked != 0) {
    return TRUE;
  }

  FrameMeasurement measurement;
  if (!MeasureWindow(hwnd, &measurement)) {
    return TRUE;
  }

  WindowCandidate candidate;
  candidate.hwnd = hwnd;
  candidate.measurement = measurement;
  candidate.metadata.visible = measurement.visible;
  candidate.metadata.is_chrome_widget = IsChromeWidgetClass(hwnd);
  candidate.metadata.is_ownerless = GetWindow(hwnd, GW_OWNER) == nullptr;
  context->candidates->push_back(candidate);
  return TRUE;
}

FindWindowResult FindWindowForProcess(DWORD pid, const Rect& target_visible) {
  const auto deadline = std::chrono::steady_clock::now() + kWindowWaitTimeout;
  FindWindowStatus last_status = FindWindowStatus::kNotFound;

  while (true) {
    std::vector<WindowCandidate> candidates;
    EnumerationContext context = {pid, &candidates};
    EnumWindows(CollectWindow, reinterpret_cast<LPARAM>(&context));

    std::vector<CandidateMetadata> metadata;
    metadata.reserve(candidates.size());
    for (const WindowCandidate& candidate : candidates) {
      metadata.push_back(candidate.metadata);
    }

    const auto selection =
        rion::window_frame::SelectBestCandidate(metadata, target_visible);
    if (selection.status == CandidateSelectionStatus::kSelected) {
      return {FindWindowStatus::kFound, candidates[selection.index]};
    }
    last_status = selection.status == CandidateSelectionStatus::kAmbiguous
                      ? FindWindowStatus::kAmbiguous
                      : FindWindowStatus::kNotFound;

    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      return {last_status, {}};
    }
    std::this_thread::sleep_for(
        std::min(kWindowPollInterval,
                 std::chrono::duration_cast<std::chrono::milliseconds>(deadline -
                                                                        now)));
  }
}

bool ParseInt32(const wchar_t* text, std::int32_t* value) {
  if (text == nullptr || value == nullptr || *text == L'\0') {
    return false;
  }
  errno = 0;
  wchar_t* end = nullptr;
  const long long parsed = std::wcstoll(text, &end, 10);
  if (errno == ERANGE || end == text || *end != L'\0' ||
      parsed < std::numeric_limits<std::int32_t>::min() ||
      parsed > std::numeric_limits<std::int32_t>::max()) {
    return false;
  }
  *value = static_cast<std::int32_t>(parsed);
  return true;
}

bool ParsePid(const wchar_t* text, DWORD* value) {
  if (text == nullptr || value == nullptr || *text == L'\0' || *text == L'-') {
    return false;
  }
  errno = 0;
  wchar_t* end = nullptr;
  const unsigned long long parsed = std::wcstoull(text, &end, 10);
  if (errno == ERANGE || end == text || *end != L'\0' || parsed == 0 ||
      parsed > std::numeric_limits<DWORD>::max()) {
    return false;
  }
  *value = static_cast<DWORD>(parsed);
  return true;
}

bool ParseOptions(int argc, wchar_t* argv[], Options* options,
                  std::string* error) {
  if (options == nullptr || error == nullptr || argc != 14 ||
      std::wcscmp(argv[1], kAlignCommand) != 0) {
    if (error != nullptr) {
      *error = "expected align-visible-frame and six option-value pairs";
    }
    return false;
  }

  bool has_protocol = false;
  bool has_pid = false;
  bool has_x = false;
  bool has_y = false;
  bool has_width = false;
  bool has_height = false;
  std::int32_t protocol = 0;

  for (int index = 2; index < argc; index += 2) {
    const wchar_t* name = argv[index];
    const wchar_t* value = argv[index + 1];
    bool parsed = false;

    if (std::wcscmp(name, L"--protocol") == 0 && !has_protocol) {
      parsed = ParseInt32(value, &protocol);
      has_protocol = parsed;
    } else if (std::wcscmp(name, L"--pid") == 0 && !has_pid) {
      parsed = ParsePid(value, &options->pid);
      has_pid = parsed;
    } else if (std::wcscmp(name, L"--x") == 0 && !has_x) {
      parsed = ParseInt32(value, &options->target.x);
      has_x = parsed;
    } else if (std::wcscmp(name, L"--y") == 0 && !has_y) {
      parsed = ParseInt32(value, &options->target.y);
      has_y = parsed;
    } else if (std::wcscmp(name, L"--width") == 0 && !has_width) {
      parsed = ParseInt32(value, &options->target.width);
      has_width = parsed;
    } else if (std::wcscmp(name, L"--height") == 0 && !has_height) {
      parsed = ParseInt32(value, &options->target.height);
      has_height = parsed;
    }

    if (!parsed) {
      *error = "unknown, duplicate, or invalid option";
      return false;
    }
  }

  if (!has_protocol || !has_pid || !has_x || !has_y || !has_width ||
      !has_height) {
    *error = "all options are required exactly once";
    return false;
  }
  if (protocol != rion::window_frame::kProtocolVersion) {
    *error = "unsupported protocol version";
    return false;
  }
  if (options->target.width <= 0 || options->target.height <= 0) {
    *error = "width and height must be positive";
    return false;
  }

  Rect target_rect;
  if (!rion::window_frame::TryMakeRect(options->target, &target_rect)) {
    *error = "target bounds exceed the supported coordinate range";
    return false;
  }
  return true;
}

void AppendBoundsJson(std::ostringstream& output, const Rect& rect) {
  output << "{\"x\":" << rect.left << ",\"y\":" << rect.top
         << ",\"width\":"
         << (static_cast<std::int64_t>(rect.right) - rect.left)
         << ",\"height\":"
         << (static_cast<std::int64_t>(rect.bottom) - rect.top) << '}';
}

void AppendMeasurementJson(std::ostringstream& output,
                           const FrameMeasurement& measurement) {
  output << "{\"outer\":";
  AppendBoundsJson(output, measurement.outer);
  output << ",\"visible\":";
  AppendBoundsJson(output, measurement.visible);
  output << '}';
}

std::string HwndString(HWND hwnd) {
  std::ostringstream output;
  output << "0x" << std::hex << std::uppercase << std::setfill('0')
         << std::setw(static_cast<int>(sizeof(std::uintptr_t) * 2))
         << reinterpret_cast<std::uintptr_t>(hwnd);
  return output.str();
}

void WriteError(const char* code, const char* message, DWORD pid,
                const Rect* target, const AlignmentResult* alignment = nullptr) {
  std::ostringstream output;
  output << "{\"protocol\":" << rion::window_frame::kProtocolVersion
         << ",\"ok\":false,\"error\":{\"code\":\"" << code
         << "\",\"message\":\"" << message << "\"}";
  if (pid != 0) {
    output << ",\"pid\":" << pid;
  }
  if (target != nullptr) {
    output << ",\"target\":";
    AppendBoundsJson(output, *target);
  }
  if (alignment != nullptr) {
    output << ",\"attempts\":" << alignment->attempts;
    if (alignment->has_before) {
      output << ",\"before\":";
      AppendMeasurementJson(output, alignment->before);
    }
    if (alignment->has_after) {
      output << ",\"after\":";
      AppendMeasurementJson(output, alignment->after);
    }
  }
  output << '}';
  std::cout << output.str() << '\n';
}

void WriteSuccess(DWORD pid, HWND hwnd, UINT dpi, const Rect& target,
                  const AlignmentResult& alignment) {
  std::ostringstream output;
  output << "{\"protocol\":" << rion::window_frame::kProtocolVersion
         << ",\"ok\":true,\"pid\":" << pid << ",\"hwnd\":\""
         << HwndString(hwnd) << "\",\"dpi\":" << dpi
         << ",\"attempts\":" << alignment.attempts << ",\"target\":";
  AppendBoundsJson(output, target);
  output << ",\"before\":";
  AppendMeasurementJson(output, alignment.before);
  output << ",\"after\":";
  AppendMeasurementJson(output, alignment.after);
  output << '}';
  std::cout << output.str() << '\n';
}

int ExitForAlignmentFailure(AlignmentFailure failure) {
  switch (failure) {
    case AlignmentFailure::kApplyFailed:
      return kExitSetWindowFailed;
    case AlignmentFailure::kFlushFailed:
      return kExitDwmFlushFailed;
    case AlignmentFailure::kExhausted:
      return kExitAlignmentFailed;
    case AlignmentFailure::kMeasurementFailed:
    case AlignmentFailure::kInvalidMeasurement:
    case AlignmentFailure::kGeometryOverflow:
      return kExitFrameQueryFailed;
    case AlignmentFailure::kNone:
      return kExitSuccess;
  }
  return kExitAlignmentFailed;
}

const char* CodeForAlignmentFailure(AlignmentFailure failure) {
  switch (failure) {
    case AlignmentFailure::kApplyFailed:
      return "set_window_failed";
    case AlignmentFailure::kFlushFailed:
      return "dwm_flush_failed";
    case AlignmentFailure::kExhausted:
      return "alignment_not_exact";
    case AlignmentFailure::kMeasurementFailed:
      return "frame_query_failed";
    case AlignmentFailure::kInvalidMeasurement:
      return "invalid_frame";
    case AlignmentFailure::kGeometryOverflow:
      return "geometry_overflow";
    case AlignmentFailure::kNone:
      return "none";
  }
  return "unknown";
}

const char* MessageForAlignmentFailure(AlignmentFailure failure) {
  switch (failure) {
    case AlignmentFailure::kApplyFailed:
      return "SetWindowPos failed";
    case AlignmentFailure::kFlushFailed:
      return "DwmFlush failed";
    case AlignmentFailure::kExhausted:
      return "visible frame did not reach the exact target after three attempts";
    case AlignmentFailure::kMeasurementFailed:
      return "failed to read the window frame";
    case AlignmentFailure::kInvalidMeasurement:
      return "window frame geometry is invalid";
    case AlignmentFailure::kGeometryOverflow:
      return "corrected outer frame exceeds the supported coordinate range";
    case AlignmentFailure::kNone:
      return "no error";
  }
  return "unknown alignment error";
}

WindowRestoreState QueryWindowRestoreState(HWND hwnd) {
  if (!IsWindow(hwnd)) {
    return WindowRestoreState::kGone;
  }
  if (IsZoomed(hwnd) || IsIconic(hwnd)) {
    return WindowRestoreState::kNeedsRestore;
  }
  return WindowRestoreState::kNormal;
}

const char* CodeForRestoreFailure(WindowRestoreFailure failure) {
  switch (failure) {
    case WindowRestoreFailure::kRequestFailed:
      return "restore_request_failed";
    case WindowRestoreFailure::kWindowDisappeared:
      return "window_disappeared";
    case WindowRestoreFailure::kTimedOut:
      return "restore_timeout";
    case WindowRestoreFailure::kNone:
      return "none";
  }
  return "unknown";
}

const char* MessageForRestoreFailure(WindowRestoreFailure failure) {
  switch (failure) {
    case WindowRestoreFailure::kRequestFailed:
      return "ShowWindowAsync failed to request a non-activating normal window state";
    case WindowRestoreFailure::kWindowDisappeared:
      return "the selected window disappeared while it was being restored";
    case WindowRestoreFailure::kTimedOut:
      return "the selected window did not leave its maximized or minimized state";
    case WindowRestoreFailure::kNone:
      return "no error";
  }
  return "unknown restore error";
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  if (argc == 2 && std::wcscmp(argv[1], L"--version") == 0) {
    std::cout << "rion-window-frame-helper protocol "
              << rion::window_frame::kProtocolVersion << '\n';
    return kExitSuccess;
  }

  Options options;
  std::string parse_error;
  if (!ParseOptions(argc, argv, &options, &parse_error)) {
    WriteError("invalid_arguments", parse_error.c_str(), 0, nullptr);
    return kExitInvalidArguments;
  }

  Rect target;
  rion::window_frame::TryMakeRect(options.target, &target);
  const FindWindowResult found = FindWindowForProcess(options.pid, target);
  if (found.status == FindWindowStatus::kNotFound) {
    WriteError("window_not_found",
               "no eligible top-level window was found for the process",
               options.pid, &target);
    return kExitWindowNotFound;
  }
  if (found.status == FindWindowStatus::kAmbiguous) {
    WriteError("ambiguous_window",
               "multiple equally ranked windows were found for the process",
               options.pid, &target);
    return kExitAmbiguousWindow;
  }

  const HWND hwnd = found.candidate.hwnd;
  WindowRestoreCallbacks restore_callbacks;
  restore_callbacks.query_state = [hwnd] {
    return QueryWindowRestoreState(hwnd);
  };
  restore_callbacks.request_restore = [hwnd] {
    return ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE) != FALSE;
  };
  restore_callbacks.wait_for_next_poll = [] {
    std::this_thread::sleep_for(kRestorePollInterval);
  };
  const auto restore =
      rion::window_frame::EnsureWindowRestored(restore_callbacks);
  if (!restore.success) {
    WriteError(CodeForRestoreFailure(restore.failure),
               MessageForRestoreFailure(restore.failure), options.pid,
               &target);
    return kExitRestoreFailed;
  }

  AlignmentCallbacks callbacks;
  callbacks.measure = [hwnd](FrameMeasurement* measurement) {
    return MeasureWindow(hwnd, measurement);
  };
  callbacks.apply_outer = [hwnd](const Rect& outer) {
    if (!rion::window_frame::IsValidRect(outer)) {
      return false;
    }
    const std::int64_t width =
        static_cast<std::int64_t>(outer.right) - outer.left;
    const std::int64_t height =
        static_cast<std::int64_t>(outer.bottom) - outer.top;
    return SetWindowPos(hwnd, nullptr, outer.left, outer.top,
                        static_cast<int>(width), static_cast<int>(height),
                        SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER) !=
           FALSE;
  };
  callbacks.flush = [] { return SUCCEEDED(DwmFlush()); };

  const AlignmentResult alignment =
      rion::window_frame::AlignVisibleFrame(target, callbacks);
  if (!alignment.success) {
    WriteError(CodeForAlignmentFailure(alignment.failure),
               MessageForAlignmentFailure(alignment.failure), options.pid,
               &target, &alignment);
    return ExitForAlignmentFailure(alignment.failure);
  }

  UINT dpi = GetDpiForWindow(hwnd);
  if (dpi == 0) {
    dpi = USER_DEFAULT_SCREEN_DPI;
  }
  WriteSuccess(options.pid, hwnd, dpi, target, alignment);
  return kExitSuccess;
}

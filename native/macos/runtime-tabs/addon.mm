#include <node_api.h>

#import <AppKit/AppKit.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#import "RionRuntimeTabsController.h"
#import "RionSystemWebViewSurface.h"

namespace {

constexpr int32_t kProtocolVersion = 11;

struct ControllerRecord {
  __strong RionRuntimeTabsController *controller = nil;
  napi_ref callback = nullptr;
  napi_ref content_layout_callback = nullptr;
};

struct SystemSurfaceRecord {
  __strong RionSystemWebViewSurface *surface = nil;
  napi_ref callback = nullptr;
};

std::unordered_map<int64_t, std::unique_ptr<ControllerRecord>> controllers;
std::unordered_map<int64_t, std::unique_ptr<SystemSurfaceRecord>>
    system_surfaces;
int64_t next_controller_id = 1;
int64_t next_system_surface_id = 1;
napi_env addon_env = nullptr;

void Throw(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
}

bool Check(napi_env env, napi_status status, const char *message) {
  if (status == napi_ok) return true;
  Throw(env, message);
  return false;
}

napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

bool GetInt64(napi_env env, napi_value value, int64_t *result) {
  return Check(env, napi_get_value_int64(env, value, result),
               "Expected a native controller identifier.");
}

ControllerRecord *GetController(napi_env env, napi_value value) {
  int64_t controller_id = 0;
  if (!GetInt64(env, value, &controller_id)) return nullptr;
  auto iterator = controllers.find(controller_id);
  if (iterator == controllers.end()) {
    Throw(env, "The macOS runtime tabs controller no longer exists.");
    return nullptr;
  }
  return iterator->second.get();
}

SystemSurfaceRecord *GetSystemSurface(napi_env env, napi_value value) {
  int64_t surface_id = 0;
  if (!GetInt64(env, value, &surface_id)) return nullptr;
  auto iterator = system_surfaces.find(surface_id);
  if (iterator == system_surfaces.end()) {
    Throw(env, "The macOS system WebView surface no longer exists.");
    return nullptr;
  }
  return iterator->second.get();
}

napi_value GetNamed(napi_env env, napi_value object, const char *name) {
  napi_value value;
  if (!Check(env, napi_get_named_property(env, object, name, &value),
             "Invalid macOS runtime tabs state.")) {
    return nullptr;
  }
  return value;
}

std::string GetString(napi_env env, napi_value value, const char *message) {
  size_t length = 0;
  if (!Check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length),
             message)) {
    return {};
  }
  std::vector<char> bytes(length + 1);
  if (!Check(env,
             napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(),
                                        &length),
             message)) {
    return {};
  }
  return std::string(bytes.data(), length);
}

NSString *GetNSString(napi_env env, napi_value value, const char *message) {
  std::string string = GetString(env, value, message);
  return [NSString stringWithUTF8String:string.c_str()] ?: @"";
}

NSString *GetOptionalNSString(napi_env env, napi_value object, const char *name) {
  bool has_property = false;
  if (napi_has_named_property(env, object, name, &has_property) != napi_ok ||
      !has_property) {
    return nil;
  }
  napi_value value = GetNamed(env, object, name);
  if (!value) return nil;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return nil;
  return GetNSString(env, value, "Invalid optional string in runtime tabs state.");
}

napi_value NSStringValue(napi_env env, NSString *string) {
  napi_value value;
  const char *utf8 = string.UTF8String ?: "";
  napi_create_string_utf8(env, utf8, NAPI_AUTO_LENGTH, &value);
  return value;
}

napi_value NSDictionaryValue(napi_env env, NSDictionary<NSString *, id> *dictionary) {
  napi_value result;
  napi_create_object(env, &result);
  for (NSString *key in dictionary) {
    id item = dictionary[key];
    napi_value value;
    if ([item isKindOfClass:NSString.class]) {
      value = NSStringValue(env, item);
    } else if ([item isKindOfClass:NSNumber.class]) {
      napi_create_int64(env, [item longLongValue], &value);
    } else {
      continue;
    }
    napi_set_named_property(env, result, key.UTF8String, value);
  }
  return result;
}

napi_value ContentLayoutValue(napi_env env, RionRuntimeContentLayout layout) {
  napi_value result;
  napi_value height_inset;
  napi_value valid;
  napi_value y_offset;
  napi_create_object(env, &result);
  napi_create_double(env, layout.heightInset, &height_inset);
  napi_get_boolean(env, layout.valid, &valid);
  napi_create_double(env, layout.yOffset, &y_offset);
  napi_set_named_property(env, result, "heightInset", height_inset);
  napi_set_named_property(env, result, "valid", valid);
  napi_set_named_property(env, result, "yOffset", y_offset);
  return result;
}

void EmitAction(int64_t controller_id,
                NSDictionary<NSString *, id> *action) {
  auto iterator = controllers.find(controller_id);
  if (iterator == controllers.end() || !addon_env) return;
  napi_handle_scope scope;
  if (napi_open_handle_scope(addon_env, &scope) != napi_ok) return;
  napi_value callback;
  napi_value global;
  if (napi_get_reference_value(addon_env, iterator->second->callback, &callback) ==
          napi_ok &&
      napi_get_global(addon_env, &global) == napi_ok) {
    napi_value argument = NSDictionaryValue(addon_env, action);
    napi_value ignored;
    napi_call_function(addon_env, global, callback, 1, &argument, &ignored);
  }
  napi_close_handle_scope(addon_env, scope);
}

void EmitContentLayout(int64_t controller_id,
                       RionRuntimeContentLayout layout) {
  auto iterator = controllers.find(controller_id);
  if (iterator == controllers.end() || !addon_env) return;
  napi_handle_scope scope;
  if (napi_open_handle_scope(addon_env, &scope) != napi_ok) return;
  napi_value callback;
  napi_value global;
  if (napi_get_reference_value(addon_env,
                               iterator->second->content_layout_callback,
                               &callback) == napi_ok &&
      napi_get_global(addon_env, &global) == napi_ok) {
    napi_value argument = ContentLayoutValue(addon_env, layout);
    napi_value ignored;
    napi_call_function(addon_env, global, callback, 1, &argument, &ignored);
  }
  napi_close_handle_scope(addon_env, scope);
}

void EmitSystemSurfaceEvent(int64_t surface_id,
                            NSDictionary<NSString *, id> *event) {
  auto iterator = system_surfaces.find(surface_id);
  if (iterator == system_surfaces.end() || !addon_env) return;
  napi_handle_scope scope;
  if (napi_open_handle_scope(addon_env, &scope) != napi_ok) return;
  napi_value callback;
  napi_value global;
  if (napi_get_reference_value(addon_env, iterator->second->callback,
                               &callback) == napi_ok &&
      napi_get_global(addon_env, &global) == napi_ok) {
    napi_value argument = NSDictionaryValue(addon_env, event);
    napi_value ignored;
    napi_call_function(addon_env, global, callback, 1, &argument, &ignored);
  }
  napi_close_handle_scope(addon_env, scope);
}

NSView *GetNativeView(napi_env env, napi_value value) {
  void *buffer_data = nullptr;
  size_t buffer_length = 0;
  if (!Check(env, napi_get_buffer_info(env, value, &buffer_data, &buffer_length),
             "Expected Electron's native NSView handle.") ||
      buffer_length < sizeof(uintptr_t)) {
    Throw(env, "Electron returned an invalid native NSView handle.");
    return nil;
  }
  uintptr_t pointer = 0;
  std::memcpy(&pointer, buffer_data, sizeof(pointer));
  return (__bridge NSView *)(reinterpret_cast<void *>(pointer));
}

RionRuntimeTabsState *ParseState(napi_env env, napi_value value) {
  RionRuntimeTabsState *state = [[RionRuntimeTabsState alloc] init];
  int32_t display_id = 0;
  napi_value display_value = GetNamed(env, value, "displayId");
  if (!display_value ||
      !Check(env, napi_get_value_int32(env, display_value, &display_id),
             "Invalid displayId in runtime tabs state.")) {
    return nil;
  }
  state.displayID = display_id;

  napi_value labels = GetNamed(env, value, "labels");
  if (!labels) return nil;
  state.addLabel = GetNSString(env, GetNamed(env, labels, "add"),
                               "Invalid add label in runtime tabs state.");
  state.audioMutedLabel = GetNSString(
      env, GetNamed(env, labels, "audioMuted"),
      "Invalid audio muted label in runtime tabs state.");
  state.audioPlayingLabel = GetNSString(
      env, GetNamed(env, labels, "audioPlaying"),
      "Invalid audio playing label in runtime tabs state.");
  state.closeLabel = GetNSString(env, GetNamed(env, labels, "close"),
                                 "Invalid close label in runtime tabs state.");

  napi_value tabs = GetNamed(env, value, "tabs");
  bool is_array = false;
  if (!tabs || napi_is_array(env, tabs, &is_array) != napi_ok || !is_array) {
    Throw(env, "Runtime tabs state must contain a tabs array.");
    return nil;
  }
  uint32_t length = 0;
  napi_get_array_length(env, tabs, &length);
  NSMutableArray<RionRuntimeTabModel *> *models =
      [NSMutableArray arrayWithCapacity:length];
  for (uint32_t index = 0; index < length; ++index) {
    napi_value tab;
    if (napi_get_element(env, tabs, index, &tab) != napi_ok) return nil;
    RionRuntimeTabModel *model = [[RionRuntimeTabModel alloc] init];
    model.identifier = GetNSString(env, GetNamed(env, tab, "id"),
                                   "Invalid runtime tab identifier.");
    model.name = GetNSString(env, GetNamed(env, tab, "name"),
                             "Invalid runtime tab name.");
    model.tooltip = GetNSString(env, GetNamed(env, tab, "tooltip"),
                                "Invalid runtime tab tooltip.");
    model.type = GetNSString(env, GetNamed(env, tab, "type"),
                             "Invalid runtime tab type.");
    model.iconDataURL = GetOptionalNSString(env, tab, "iconDataUrl");
    model.workspaceTemplate = GetOptionalNSString(env, tab, "workspaceTemplate");
    napi_value audible = GetNamed(env, tab, "audible");
    bool audible_value = false;
    if (!audible || napi_get_value_bool(env, audible, &audible_value) != napi_ok) {
      Throw(env, "Invalid audible state for runtime tab.");
      return nil;
    }
    model.audible = audible_value;
    napi_value audio_muted = GetNamed(env, tab, "audioMuted");
    bool audio_muted_value = false;
    if (!audio_muted ||
        napi_get_value_bool(env, audio_muted, &audio_muted_value) != napi_ok) {
      Throw(env, "Invalid muted state for runtime tab.");
      return nil;
    }
    model.audioMuted = audio_muted_value;
    napi_value active = GetNamed(env, tab, "active");
    bool active_value = false;
    if (!active || napi_get_value_bool(env, active, &active_value) != napi_ok) {
      Throw(env, "Invalid active state for runtime tab.");
      return nil;
    }
    model.active = active_value;
    [models addObject:model];
  }
  state.tabs = models;
  return state;
}

napi_value CreateController(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  if (!Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr),
             "Unable to read controller arguments.") ||
      argc != 3) {
    Throw(env, "createController requires a window handle and two callbacks.");
    return nullptr;
  }
  napi_valuetype callback_type;
  napi_typeof(env, args[1], &callback_type);
  if (callback_type != napi_function) {
    Throw(env, "The native runtime tabs action callback must be a function.");
    return nullptr;
  }
  napi_valuetype content_layout_callback_type;
  napi_typeof(env, args[2], &content_layout_callback_type);
  if (content_layout_callback_type != napi_function) {
    Throw(env, "The native content layout callback must be a function.");
    return nullptr;
  }

  NSView *native_view = GetNativeView(env, args[0]);
  if (!native_view) return nullptr;
  NSWindow *window = native_view.window;
  if (!window) {
    Throw(env, "The Electron NSView is not attached to an NSWindow.");
    return nullptr;
  }

  int64_t controller_id = next_controller_id++;
  auto record = std::make_unique<ControllerRecord>();
  if (!Check(env, napi_create_reference(env, args[1], 1, &record->callback),
             "Unable to retain the runtime tabs callback.")) {
    return nullptr;
  }
  if (!Check(env,
             napi_create_reference(env, args[2], 1,
                                   &record->content_layout_callback),
             "Unable to retain the content layout callback.")) {
    napi_delete_reference(env, record->callback);
    return nullptr;
  }
  __weak NSWindow *weak_window = window;
  record->controller = [[RionRuntimeTabsController alloc]
      initWithWindow:weak_window
       actionHandler:^(NSDictionary<NSString *, id> *action) {
    EmitAction(controller_id, action);
  }
       contentLayoutHandler:^(RionRuntimeContentLayout layout) {
    EmitContentLayout(controller_id, layout);
  }];
  if (!record->controller) {
    napi_delete_reference(env, record->callback);
    napi_delete_reference(env, record->content_layout_callback);
    Throw(env, "Unable to attach the native runtime tabs titlebar.");
    return nullptr;
  }
  controllers.emplace(controller_id, std::move(record));
  napi_value result;
  napi_create_int64(env, controller_id, &result);
  return result;
}

napi_value CreateSystemWebView(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  if (!Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr),
             "Unable to read system WebView arguments.") ||
      argc != 3) {
    Throw(env,
          "createSystemWebView requires a window handle, options, and callback.");
    return nullptr;
  }
  NSView *parent_view = GetNativeView(env, args[0]);
  if (!parent_view || !parent_view.window) {
    Throw(env, "The Electron NSView is not attached to an NSWindow.");
    return nullptr;
  }
  napi_valuetype callback_type;
  napi_typeof(env, args[2], &callback_type);
  if (callback_type != napi_function) {
    Throw(env, "The system WebView event callback must be a function.");
    return nullptr;
  }
  NSString *data_store_identifier = GetNSString(
      env, GetNamed(env, args[1], "dataStoreIdentifier"),
      "A valid WKWebsiteDataStore identifier is required.");
  NSString *proxy_server =
      GetNSString(env, GetNamed(env, args[1], "proxyServer"),
                  "The System WebView proxy server is invalid.");
  if (![[NSUUID alloc] initWithUUIDString:data_store_identifier]) {
    Throw(env, "The WKWebsiteDataStore identifier must be a UUID.");
    return nullptr;
  }

  int64_t surface_id = next_system_surface_id++;
  auto record = std::make_unique<SystemSurfaceRecord>();
  if (!Check(env, napi_create_reference(env, args[2], 1, &record->callback),
             "Unable to retain the system WebView callback.")) {
    return nullptr;
  }
  record->surface = [[RionSystemWebViewSurface alloc]
          initWithParentView:parent_view
      dataStoreIdentifier:data_store_identifier
              proxyServer:proxy_server
             eventHandler:^(NSDictionary<NSString *, id> *event) {
    EmitSystemSurfaceEvent(surface_id, event);
  }];
  if (!record->surface) {
    napi_delete_reference(env, record->callback);
    Throw(env,
          "Unable to create WKWebView. Rion Studio requires macOS 14 or newer.");
    return nullptr;
  }
  system_surfaces.emplace(surface_id, std::move(record));
  napi_value result;
  napi_create_int64(env, surface_id, &result);
  return result;
}

napi_value DestroySystemWebView(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1) {
    Throw(env, "destroySystemWebView requires an identifier.");
    return nullptr;
  }
  int64_t surface_id = 0;
  if (!GetInt64(env, args[0], &surface_id)) return nullptr;
  auto iterator = system_surfaces.find(surface_id);
  if (iterator == system_surfaces.end()) return Undefined(env);
  [iterator->second->surface destroy];
  napi_delete_reference(env, iterator->second->callback);
  system_surfaces.erase(iterator);
  return Undefined(env);
}

napi_value LoadSystemWebViewURL(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    Throw(env, "loadSystemWebViewURL requires an identifier and URL.");
    return nullptr;
  }
  SystemSurfaceRecord *record = GetSystemSurface(env, args[0]);
  if (!record) return nullptr;
  [record->surface
      loadURL:GetNSString(env, args[1], "The system WebView URL is invalid.")];
  return Undefined(env);
}

napi_value EvaluateSystemWebView(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 3) {
    Throw(env,
          "evaluateSystemWebView requires an identifier, request ID, and source.");
    return nullptr;
  }
  SystemSurfaceRecord *record = GetSystemSurface(env, args[0]);
  if (!record) return nullptr;
  NSString *request_id =
      GetNSString(env, args[1], "The evaluation request ID is invalid.");
  NSString *source =
      GetNSString(env, args[2], "The evaluation source is invalid.");
  [record->surface evaluateJavaScript:source requestID:request_id];
  return Undefined(env);
}

napi_value AddSystemWebViewDocumentStartScript(napi_env env,
                                               napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 3) {
    Throw(env,
          "addSystemWebViewDocumentStartScript requires an identifier, request ID, and source.");
    return nullptr;
  }
  SystemSurfaceRecord *record = GetSystemSurface(env, args[0]);
  if (!record) return nullptr;
  NSString *request_id =
      GetNSString(env, args[1], "The document-start request ID is invalid.");
  NSString *source =
      GetNSString(env, args[2], "The document-start source is invalid.");
  [record->surface addDocumentStartScript:source requestID:request_id];
  return Undefined(env);
}

napi_value ClearSystemWebViewData(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    Throw(env,
          "clearSystemWebViewData requires an identifier and request ID.");
    return nullptr;
  }
  SystemSurfaceRecord *record = GetSystemSurface(env, args[0]);
  if (!record) return nullptr;
  [record->surface
      clearWebsiteDataForRequest:GetNSString(
                                     env, args[1],
                                     "The website-data request ID is invalid.")];
  return Undefined(env);
}

napi_value SetSystemWebViewBounds(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    Throw(env, "setSystemWebViewBounds requires an identifier and bounds.");
    return nullptr;
  }
  SystemSurfaceRecord *record = GetSystemSurface(env, args[0]);
  if (!record) return nullptr;
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
  bool valid =
      napi_get_value_double(env, GetNamed(env, args[1], "x"), &x) == napi_ok &&
      napi_get_value_double(env, GetNamed(env, args[1], "y"), &y) == napi_ok &&
      napi_get_value_double(env, GetNamed(env, args[1], "width"), &width) ==
          napi_ok &&
      napi_get_value_double(env, GetNamed(env, args[1], "height"), &height) ==
          napi_ok;
  if (!valid || width < 0 || height < 0) {
    Throw(env, "The system WebView bounds are invalid.");
    return nullptr;
  }
  [record->surface setFrameFromTopLeftRect:NSMakeRect(x, y, width, height)];
  return Undefined(env);
}

napi_value SetSystemWebViewVisible(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    Throw(env, "setSystemWebViewVisible requires an identifier and boolean.");
    return nullptr;
  }
  SystemSurfaceRecord *record = GetSystemSurface(env, args[0]);
  if (!record) return nullptr;
  bool visible = false;
  if (!Check(env, napi_get_value_bool(env, args[1], &visible),
             "The system WebView visibility must be a boolean.")) {
    return nullptr;
  }
  [record->surface setVisible:visible];
  return Undefined(env);
}

napi_value SetSystemWebViewZoom(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    Throw(env, "setSystemWebViewZoom requires an identifier and factor.");
    return nullptr;
  }
  SystemSurfaceRecord *record = GetSystemSurface(env, args[0]);
  if (!record) return nullptr;
  double zoom = 0;
  if (!Check(env, napi_get_value_double(env, args[1], &zoom),
             "The system WebView zoom factor is invalid.")) {
    return nullptr;
  }
  [record->surface setPageZoom:zoom];
  return Undefined(env);
}

napi_value SetSystemWebViewAudioMuted(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    Throw(env,
          "setSystemWebViewAudioMuted requires an identifier and boolean.");
    return nullptr;
  }
  SystemSurfaceRecord *record = GetSystemSurface(env, args[0]);
  if (!record) return nullptr;
  bool muted = false;
  if (!Check(env, napi_get_value_bool(env, args[1], &muted),
             "The system WebView mute state must be a boolean.")) {
    return nullptr;
  }
  napi_value result;
  napi_get_boolean(env, [record->surface setAudioMuted:muted], &result);
  return result;
}

napi_value FocusSystemWebView(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1) {
    Throw(env, "focusSystemWebView requires an identifier.");
    return nullptr;
  }
  SystemSurfaceRecord *record = GetSystemSurface(env, args[0]);
  if (!record) return nullptr;
  [record->surface focus];
  return Undefined(env);
}

napi_value UpdateController(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    Throw(env, "updateController requires an identifier and state.");
    return nullptr;
  }
  ControllerRecord *record = GetController(env, args[0]);
  if (!record) return nullptr;
  RionRuntimeTabsState *state = ParseState(env, args[1]);
  if (!state) return nullptr;
  [record->controller updateState:state];
  return Undefined(env);
}

napi_value SetFullscreenPolicy(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    Throw(env, "setFullscreenPolicy requires an identifier and policy.");
    return nullptr;
  }
  ControllerRecord *record = GetController(env, args[0]);
  if (!record) return nullptr;
  NSString *policy = GetNSString(env, args[1], "Invalid fullscreen policy.");
  if (![policy isEqualToString:@"always"] &&
      ![policy isEqualToString:@"autoHide"]) {
    Throw(env, "Fullscreen policy must be always or autoHide.");
    return nullptr;
  }
  [record->controller setAlwaysShowInFullScreen:[policy isEqualToString:@"always"]];
  return Undefined(env);
}

napi_value PrepareFullscreenTransition(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    Throw(env, "prepareFullscreenTransition requires an identifier and boolean.");
    return nullptr;
  }
  ControllerRecord *record = GetController(env, args[0]);
  if (!record) return nullptr;
  bool full_screen = false;
  if (!Check(env, napi_get_value_bool(env, args[1], &full_screen),
             "Fullscreen transition state must be a boolean.")) {
    return nullptr;
  }
  [record->controller prepareForFullscreenTransition:full_screen];
  return Undefined(env);
}

napi_value SetRevealLocked(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    Throw(env, "setRevealLocked requires an identifier and boolean.");
    return nullptr;
  }
  ControllerRecord *record = GetController(env, args[0]);
  if (!record) return nullptr;
  bool locked = false;
  if (!Check(env, napi_get_value_bool(env, args[1], &locked),
             "Reveal lock must be a boolean.")) {
    return nullptr;
  }
  [record->controller setRevealLocked:locked];
  return Undefined(env);
}

napi_value GetContentLayout(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1) {
    Throw(env, "getContentLayout requires an identifier.");
    return nullptr;
  }
  ControllerRecord *record = GetController(env, args[0]);
  if (!record) return nullptr;
  return ContentLayoutValue(env, [record->controller contentLayout]);
}

napi_value DestroyController(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1) {
    Throw(env, "destroyController requires an identifier.");
    return nullptr;
  }
  int64_t controller_id = 0;
  if (!GetInt64(env, args[0], &controller_id)) return nullptr;
  auto iterator = controllers.find(controller_id);
  if (iterator == controllers.end()) return Undefined(env);
  [iterator->second->controller destroy];
  napi_delete_reference(env, iterator->second->callback);
  napi_delete_reference(env, iterator->second->content_layout_callback);
  controllers.erase(iterator);
  return Undefined(env);
}

void Cleanup(void *data) {
  (void)data;
  for (auto &entry : controllers) {
    [entry.second->controller destroy];
    if (entry.second->callback) napi_delete_reference(addon_env, entry.second->callback);
    if (entry.second->content_layout_callback) {
      napi_delete_reference(addon_env, entry.second->content_layout_callback);
    }
  }
  controllers.clear();
  for (auto &entry : system_surfaces) {
    [entry.second->surface destroy];
    if (entry.second->callback) {
      napi_delete_reference(addon_env, entry.second->callback);
    }
  }
  system_surfaces.clear();
  addon_env = nullptr;
}

napi_value Initialize(napi_env env, napi_value exports) {
  addon_env = env;
  napi_property_descriptor properties[] = {
      {"createController", nullptr, CreateController, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"updateController", nullptr, UpdateController, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"prepareFullscreenTransition", nullptr, PrepareFullscreenTransition,
       nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getContentLayout", nullptr, GetContentLayout, nullptr,
       nullptr, nullptr, napi_default, nullptr},
      {"setFullscreenPolicy", nullptr, SetFullscreenPolicy, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"setRevealLocked", nullptr, SetRevealLocked, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"destroyController", nullptr, DestroyController, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"createSystemWebView", nullptr, CreateSystemWebView, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"destroySystemWebView", nullptr, DestroySystemWebView, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"loadSystemWebViewURL", nullptr, LoadSystemWebViewURL, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"evaluateSystemWebView", nullptr, EvaluateSystemWebView, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"addSystemWebViewDocumentStartScript", nullptr,
       AddSystemWebViewDocumentStartScript, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"clearSystemWebViewData", nullptr, ClearSystemWebViewData, nullptr,
       nullptr, nullptr, napi_default, nullptr},
      {"setSystemWebViewBounds", nullptr, SetSystemWebViewBounds, nullptr,
       nullptr, nullptr, napi_default, nullptr},
      {"setSystemWebViewVisible", nullptr, SetSystemWebViewVisible, nullptr,
       nullptr, nullptr, napi_default, nullptr},
      {"setSystemWebViewZoom", nullptr, SetSystemWebViewZoom, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"setSystemWebViewAudioMuted", nullptr, SetSystemWebViewAudioMuted,
       nullptr, nullptr, nullptr, napi_default, nullptr},
      {"focusSystemWebView", nullptr, FocusSystemWebView, nullptr, nullptr,
       nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, std::size(properties), properties);
  napi_value protocol;
  napi_create_int32(env, kProtocolVersion, &protocol);
  napi_set_named_property(env, exports, "protocolVersion", protocol);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)

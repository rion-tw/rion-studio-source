#include <node_api.h>

#include <windows.h>
#include <wrl.h>

#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <memory>
#include <optional>
#include <regex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace {

constexpr int32_t kProtocolVersion = 6;

struct CookieInput {
  std::wstring domain;
  std::optional<double> expiration_date;
  bool http_only = false;
  std::wstring name;
  std::wstring path = L"/";
  COREWEBVIEW2_COOKIE_SAME_SITE_KIND same_site =
      COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE;
  bool secure = false;
  std::wstring value;
};

struct PendingReadyAction {
  std::function<void()> action;
  std::function<void(const std::string&)> failure;
};

struct RequestRewriteRule {
  std::wregex matcher;
  std::wstring substitution;
  std::wstring source_host;
};

struct PopupWebView {
  ComPtr<ICoreWebView2Controller> controller;
  ComPtr<ICoreWebView2> webview;
  EventRegistrationToken audio_token{};
  EventRegistrationToken close_token{};
  EventRegistrationToken download_token{};
  EventRegistrationToken permission_token{};
  EventRegistrationToken process_failed_token{};
  EventRegistrationToken web_message_token{};
  EventRegistrationToken web_resource_requested_token{};
};

class WebView2Surface;

struct SurfaceRecord {
  std::shared_ptr<WebView2Surface> surface;
  napi_ref callback = nullptr;
};

napi_env addon_env = nullptr;
int64_t next_surface_id = 1;
std::unordered_map<int64_t, std::unique_ptr<SurfaceRecord>> surfaces;

void Throw(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
}

bool Check(napi_env env, napi_status status, const char* message) {
  if (status == napi_ok) return true;
  Throw(env, message);
  return false;
}

napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

std::string Utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(),
                                       static_cast<int>(value.size()), nullptr, 0,
                                       nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                      result.data(), size, nullptr, nullptr);
  return result;
}

std::wstring Wide(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, value.data(),
                                       static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) return {};
  std::wstring result(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                      result.data(), size);
  return result;
}

std::string HResultMessage(HRESULT result) {
  std::ostringstream stream;
  stream << "WebView2 operation failed (HRESULT 0x" << std::hex
         << static_cast<uint32_t>(result) << ").";
  return stream.str();
}

std::string JsonEscape(const std::string& value) {
  std::ostringstream output;
  for (const unsigned char character : value) {
    switch (character) {
      case '\\':
        output << "\\\\";
        break;
      case '"':
        output << "\\\"";
        break;
      case '\b':
        output << "\\b";
        break;
      case '\f':
        output << "\\f";
        break;
      case '\n':
        output << "\\n";
        break;
      case '\r':
        output << "\\r";
        break;
      case '\t':
        output << "\\t";
        break;
      default:
        if (character < 0x20) {
          output << "\\u00";
          constexpr char digits[] = "0123456789abcdef";
          output << digits[(character >> 4) & 0xf] << digits[character & 0xf];
        } else {
          output << character;
        }
    }
  }
  return output.str();
}

void SetString(napi_env env, napi_value object, const char* name,
               const std::string& value) {
  napi_value property;
  napi_create_string_utf8(env, value.c_str(), value.size(), &property);
  napi_set_named_property(env, object, name, property);
}

void SetBoolean(napi_env env, napi_value object, const char* name, bool value) {
  napi_value property;
  napi_get_boolean(env, value, &property);
  napi_set_named_property(env, object, name, property);
}

void SetNumber(napi_env env, napi_value object, const char* name, double value) {
  napi_value property;
  napi_create_double(env, value, &property);
  napi_set_named_property(env, object, name, property);
}

void EmitEvent(
    int64_t surface_id, const std::string& type,
    const std::vector<std::pair<std::string, std::string>>& strings = {},
    const std::vector<std::pair<std::string, bool>>& booleans = {},
    const std::vector<std::pair<std::string, double>>& numbers = {}) {
  auto iterator = surfaces.find(surface_id);
  if (iterator == surfaces.end() || !addon_env) return;
  napi_handle_scope scope;
  if (napi_open_handle_scope(addon_env, &scope) != napi_ok) return;
  napi_value callback;
  napi_value global;
  if (napi_get_reference_value(addon_env, iterator->second->callback,
                               &callback) == napi_ok &&
      napi_get_global(addon_env, &global) == napi_ok) {
    napi_value event;
    napi_create_object(addon_env, &event);
    SetString(addon_env, event, "type", type);
    for (const auto& [name, value] : strings) {
      SetString(addon_env, event, name.c_str(), value);
    }
    for (const auto& [name, value] : booleans) {
      SetBoolean(addon_env, event, name.c_str(), value);
    }
    for (const auto& [name, value] : numbers) {
      SetNumber(addon_env, event, name.c_str(), value);
    }
    napi_value ignored;
    napi_call_function(addon_env, global, callback, 1, &event, &ignored);
  }
  napi_close_handle_scope(addon_env, scope);
}

std::wstring TakeWideString(LPWSTR value) {
  if (!value) return {};
  std::wstring result(value);
  CoTaskMemFree(value);
  return result;
}

class WebView2Surface : public std::enable_shared_from_this<WebView2Surface> {
 public:
  WebView2Surface(int64_t identifier, HWND parent,
                  std::wstring user_data_folder, std::wstring proxy_server)
      : identifier_(identifier),
        parent_(parent),
        user_data_folder_(std::move(user_data_folder)),
        proxy_server_(std::move(proxy_server)) {}

  ~WebView2Surface() { Destroy(); }

  HRESULT Initialize() {
    if (!proxy_server_.empty()) {
      const auto options =
          Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
      if (!options) return E_OUTOFMEMORY;
      const std::wstring arguments = L"--proxy-server=" + proxy_server_;
      const HRESULT options_result =
          options->put_AdditionalBrowserArguments(arguments.c_str());
      if (FAILED(options_result)) return options_result;
      environment_options_ = options;
    }
    const HRESULT result = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, user_data_folder_.c_str(), environment_options_.Get(),
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [weak = weak_from_this()](HRESULT error,
                                      ICoreWebView2Environment* environment) {
              const auto self = weak.lock();
              if (!self) return S_OK;
              if (FAILED(error) || !environment) {
                self->FailInitialization(FAILED(error) ? error : E_POINTER);
                return S_OK;
              }
              self->environment_ = environment;
              const HRESULT controller_result =
                  environment->CreateCoreWebView2Controller(
                      self->parent_,
                      Callback<
                          ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                          [weak](HRESULT controller_error,
                                 ICoreWebView2Controller* controller) {
                            const auto surface = weak.lock();
                            if (!surface) return S_OK;
                            if (FAILED(controller_error) || !controller) {
                              surface->FailInitialization(
                                  FAILED(controller_error) ? controller_error
                                                           : E_POINTER);
                              return S_OK;
                            }
                            surface->ControllerReady(controller);
                            return S_OK;
                          })
                          .Get());
              if (FAILED(controller_result)) {
                self->FailInitialization(controller_result);
              }
              return S_OK;
            })
            .Get());
    if (FAILED(result)) FailInitialization(result);
    return result;
  }

  void Destroy() {
    if (destroyed_) return;
    destroyed_ = true;
    ready_ = false;
    for (auto& popup : popups_) {
      if (popup->controller) popup->controller->Close();
    }
    popups_.clear();
    audible_states_.clear();
    if (controller_) controller_->Close();
    webview_.Reset();
    controller_.Reset();
    environment_.Reset();
    FailPending("The WebView2 surface was destroyed.");
  }

  void WhenReady(std::function<void()> action,
                 std::function<void(const std::string&)> failure = {}) {
    if (destroyed_) {
      if (failure) failure("The WebView2 surface was destroyed.");
      return;
    }
    if (failed_) {
      if (failure) failure(initialization_error_);
      return;
    }
    if (ready_) {
      action();
      return;
    }
    pending_.push_back({std::move(action), std::move(failure)});
  }

  ICoreWebView2* webview() const { return webview_.Get(); }
  ICoreWebView2Controller* controller() const { return controller_.Get(); }

  void Focus() {
    ICoreWebView2Controller* target =
        popups_.empty() ? controller_.Get() : popups_.back()->controller.Get();
    if (target) {
      target->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    }
  }

  void SetBounds(const RECT& bounds) {
    bounds_ = bounds;
    WhenReady([weak = weak_from_this()] {
      if (const auto self = weak.lock()) {
        self->controller_->put_Bounds(self->bounds_);
        for (const auto& popup : self->popups_) {
          popup->controller->put_Bounds(self->bounds_);
        }
      }
    });
  }

  void SetVisible(bool visible) {
    visible_ = visible;
    WhenReady([weak = weak_from_this()] {
      if (const auto self = weak.lock()) {
        self->controller_->put_IsVisible(self->visible_ ? TRUE : FALSE);
        for (const auto& popup : self->popups_) {
          popup->controller->put_IsVisible(self->visible_ ? TRUE : FALSE);
        }
      }
    });
  }

  void SetZoom(double factor) {
    zoom_factor_ = factor;
    WhenReady([weak = weak_from_this()] {
      if (const auto self = weak.lock()) {
        self->controller_->put_ZoomFactor(self->zoom_factor_);
        for (const auto& popup : self->popups_) {
          popup->controller->put_ZoomFactor(self->zoom_factor_);
        }
      }
    });
  }

  bool SetMuted(bool muted) {
    if (destroyed_ || failed_) return false;
    if (!ready_) {
      WhenReady([weak = weak_from_this(), muted] {
        if (const auto self = weak.lock()) self->SetMuted(muted);
      });
      return true;
    }
    ComPtr<ICoreWebView2_8> audio;
    if (FAILED(webview_->QueryInterface(IID_PPV_ARGS(&audio))) || !audio ||
        FAILED(audio->put_IsMuted(muted ? TRUE : FALSE))) {
      return false;
    }
    for (const auto& popup : popups_) {
      ComPtr<ICoreWebView2_8> popup_audio;
      if (FAILED(popup->webview.As(&popup_audio)) || !popup_audio ||
          FAILED(popup_audio->put_IsMuted(muted ? TRUE : FALSE))) {
        return false;
      }
    }
    audio_muted_ = muted;
    return true;
  }

  HRESULT ConfigureRequestRewrites(std::vector<RequestRewriteRule> rules) {
    if (request_rewrites_configured_) return E_UNEXPECTED;
    request_rewrites_ = std::move(rules);
    const HRESULT event_result =
        ApplyRequestRewrites(webview_.Get(), &web_resource_requested_token_);
    if (FAILED(event_result)) {
      request_rewrites_.clear();
      return event_result;
    }
    request_rewrites_configured_ = true;
    return S_OK;
  }

  void RememberDocumentStartScript(const std::wstring& source) {
    document_start_scripts_.push_back(source);
  }

 private:
  HRESULT ApplyRequestRewrites(
      ICoreWebView2* webview, EventRegistrationToken* token) {
    for (const auto& rule : request_rewrites_) {
      const std::wstring filter = L"https://" + rule.source_host + L"/*";
      const HRESULT filter_result = webview->AddWebResourceRequestedFilter(
          filter.c_str(), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
      if (FAILED(filter_result)) return filter_result;
    }
    return webview->add_WebResourceRequested(
        Callback<ICoreWebView2WebResourceRequestedEventHandler>(
            [weak = weak_from_this()](
                ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) {
              const auto self = weak.lock();
              if (!self || self->destroyed_) return S_OK;
              ComPtr<ICoreWebView2WebResourceRequest> request;
              if (FAILED(args->get_Request(&request)) || !request) return S_OK;
              LPWSTR raw_uri = nullptr;
              if (FAILED(request->get_Uri(&raw_uri)) || !raw_uri) return S_OK;
              const std::wstring uri = TakeWideString(raw_uri);
              for (const auto& rule : self->request_rewrites_) {
                if (!std::regex_match(uri, rule.matcher)) continue;
                const std::wstring rewritten = std::regex_replace(
                    uri, rule.matcher, rule.substitution,
                    std::regex_constants::format_first_only);
                if (rewritten != uri) request->put_Uri(rewritten.c_str());
                break;
              }
              return S_OK;
            })
            .Get(),
        token);
  }

  void PublishAudibleState(ICoreWebView2* webview, bool audible) {
    audible_states_[webview] = audible;
    EmitEvent(identifier_, "audioChanged", {},
              {{"audible", std::any_of(
                                audible_states_.begin(), audible_states_.end(),
                                [](const auto& entry) { return entry.second; })}});
  }

  void InstallPopupDocumentStartScripts(
      ComPtr<ICoreWebView2> popup, size_t index,
      std::function<void(HRESULT)> completion) {
    if (index >= document_start_scripts_.size()) {
      completion(S_OK);
      return;
    }
    const HRESULT result = popup->AddScriptToExecuteOnDocumentCreated(
        document_start_scripts_[index].c_str(),
        Callback<
            ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>(
            [weak = weak_from_this(), popup, index,
             completion](HRESULT error, LPCWSTR) mutable {
              const auto self = weak.lock();
              if (!self || self->destroyed_) return S_OK;
              if (FAILED(error)) {
                completion(error);
              } else {
                self->InstallPopupDocumentStartScripts(
                    popup, index + 1, std::move(completion));
              }
              return S_OK;
            })
            .Get());
    if (FAILED(result)) completion(result);
  }

  void ClosePopup(ICoreWebView2* webview) {
    const auto iterator = std::find_if(
        popups_.begin(), popups_.end(),
        [webview](const auto& popup) { return popup->webview.Get() == webview; });
    if (iterator == popups_.end()) return;
    LPWSTR raw_uri = nullptr;
    webview->get_Source(&raw_uri);
    const std::string url = Utf8(TakeWideString(raw_uri));
    audible_states_.erase(webview);
    (*iterator)->controller->Close();
    popups_.erase(iterator);
    EmitEvent(identifier_, "popupClosed", {{"url", url}});
    PublishAudibleState(webview_.Get(), audible_states_[webview_.Get()]);
  }

  void FailPopup(
      ICoreWebView2NewWindowRequestedEventArgs* arguments,
      ICoreWebView2Deferral* deferral, ICoreWebView2Controller* controller,
      const std::string& url) {
    if (controller) controller->Close();
    arguments->put_Handled(TRUE);
    if (deferral) deferral->Complete();
    EmitEvent(identifier_, "popupRequested", {{"url", url}});
  }

  void CreatePopup(ICoreWebView2NewWindowRequestedEventArgs* raw_arguments) {
    ComPtr<ICoreWebView2NewWindowRequestedEventArgs> arguments = raw_arguments;
    ComPtr<ICoreWebView2Deferral> deferral;
    if (FAILED(arguments->GetDeferral(&deferral)) || !deferral) {
      LPWSTR raw_uri = nullptr;
      arguments->get_Uri(&raw_uri);
      arguments->put_Handled(TRUE);
      EmitEvent(identifier_, "popupRequested",
                {{"url", Utf8(TakeWideString(raw_uri))}});
      return;
    }
    LPWSTR raw_uri = nullptr;
    arguments->get_Uri(&raw_uri);
    const std::string url = Utf8(TakeWideString(raw_uri));
    const HRESULT result = environment_->CreateCoreWebView2Controller(
        parent_,
        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
            [weak = weak_from_this(), arguments, deferral,
             url](HRESULT error, ICoreWebView2Controller* raw_controller) {
              const auto self = weak.lock();
              if (!self || self->destroyed_) {
                if (raw_controller) raw_controller->Close();
                arguments->put_Handled(TRUE);
                deferral->Complete();
                return S_OK;
              }
              ComPtr<ICoreWebView2Controller> controller = raw_controller;
              ComPtr<ICoreWebView2> popup;
              HRESULT setup = error;
              if (SUCCEEDED(setup) && controller) {
                setup = controller->get_CoreWebView2(&popup);
              }
              if (FAILED(setup) || !controller || !popup) {
                self->FailPopup(arguments.Get(), deferral.Get(),
                                controller.Get(), url);
                return S_OK;
              }
              controller->put_Bounds(self->bounds_);
              controller->put_IsVisible(self->visible_ ? TRUE : FALSE);
              controller->put_ZoomFactor(self->zoom_factor_);
              self->InstallPopupDocumentStartScripts(
                  popup, 0,
                  [weak, arguments, deferral, controller, popup,
                   url](HRESULT script_error) {
                    const auto surface = weak.lock();
                    if (!surface || surface->destroyed_) {
                      controller->Close();
                      arguments->put_Handled(TRUE);
                      deferral->Complete();
                      return;
                    }
                    if (FAILED(script_error)) {
                      surface->FailPopup(arguments.Get(), deferral.Get(),
                                         controller.Get(), url);
                      return;
                    }
                    auto record = std::make_unique<PopupWebView>();
                    record->controller = controller;
                    record->webview = popup;
                    if (surface->request_rewrites_configured_ &&
                        FAILED(surface->ApplyRequestRewrites(
                            popup.Get(),
                            &record->web_resource_requested_token))) {
                      surface->FailPopup(arguments.Get(), deferral.Get(),
                                         controller.Get(), url);
                      return;
                    }
                    popup->add_WindowCloseRequested(
                        Callback<ICoreWebView2WindowCloseRequestedEventHandler>(
                            [weak, raw = popup.Get()](ICoreWebView2*, IUnknown*) {
                              if (const auto current = weak.lock()) {
                                current->ClosePopup(raw);
                              }
                              return S_OK;
                            })
                            .Get(),
                        &record->close_token);
                    ComPtr<ICoreWebView2_8> popup_audio;
                    if (SUCCEEDED(popup.As(&popup_audio)) && popup_audio) {
                      popup_audio->add_IsDocumentPlayingAudioChanged(
                          Callback<
                              ICoreWebView2IsDocumentPlayingAudioChangedEventHandler>(
                              [weak](ICoreWebView2* sender, IUnknown*) {
                                ComPtr<ICoreWebView2_8> current;
                                BOOL audible = FALSE;
                                if (SUCCEEDED(sender->QueryInterface(
                                        IID_PPV_ARGS(&current))) &&
                                    current) {
                                  current->get_IsDocumentPlayingAudio(&audible);
                                }
                                if (const auto surface = weak.lock()) {
                                  surface->PublishAudibleState(
                                      sender, audible == TRUE);
                                }
                                return S_OK;
                              })
                              .Get(),
                          &record->audio_token);
                    }
                    popup->add_WebMessageReceived(
                        Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                            [identifier = surface->identifier_](
                                ICoreWebView2*,
                                ICoreWebView2WebMessageReceivedEventArgs* event) {
                              LPWSTR raw_message = nullptr;
                              if (SUCCEEDED(event->get_WebMessageAsJson(
                                      &raw_message))) {
                                EmitEvent(
                                    identifier, "bridgeMessage",
                                    {{"messageJson",
                                      Utf8(TakeWideString(raw_message))}});
                              }
                              return S_OK;
                            })
                            .Get(),
                        &record->web_message_token);
                    popup->add_ProcessFailed(
                        Callback<ICoreWebView2ProcessFailedEventHandler>(
                            [identifier = surface->identifier_](
                                ICoreWebView2*,
                                ICoreWebView2ProcessFailedEventArgs* event) {
                              COREWEBVIEW2_PROCESS_FAILED_KIND kind =
                                  COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
                              event->get_ProcessFailedKind(&kind);
                              EmitEvent(
                                  identifier, "crashed",
                                  {{"reason",
                                    std::to_string(static_cast<int>(kind))}});
                              return S_OK;
                            })
                            .Get(),
                        &record->process_failed_token);
                    surface->RegisterSecurityAndDownloads(
                        popup.Get(), &record->permission_token,
                        &record->download_token);
                    if (surface->audio_muted_) {
                      ComPtr<ICoreWebView2_8> audio;
                      if (SUCCEEDED(popup.As(&audio)) && audio) {
                        audio->put_IsMuted(TRUE);
                      }
                    }
                    surface->audible_states_[popup.Get()] = false;
                    surface->popups_.push_back(std::move(record));
                    arguments->put_NewWindow(popup.Get());
                    arguments->put_Handled(TRUE);
                    deferral->Complete();
                    EmitEvent(surface->identifier_, "popupCreated",
                              {{"url", url}});
                  });
              return S_OK;
            })
            .Get());
    if (FAILED(result)) {
      FailPopup(arguments.Get(), deferral.Get(), nullptr, url);
    }
  }

  void ControllerReady(ICoreWebView2Controller* controller) {
    if (destroyed_) return;
    controller_ = controller;
    HRESULT result = controller_->get_CoreWebView2(&webview_);
    if (FAILED(result) || !webview_) {
      FailInitialization(FAILED(result) ? result : E_POINTER);
      return;
    }
    controller_->put_Bounds(bounds_);
    controller_->put_IsVisible(visible_ ? TRUE : FALSE);
    controller_->put_ZoomFactor(zoom_factor_);
    RegisterEvents();
    ready_ = true;
    auto pending = std::move(pending_);
    pending_.clear();
    EmitEvent(identifier_, "ready");
    for (auto& item : pending) item.action();
  }

  void RegisterSecurityAndDownloads(
      ICoreWebView2* webview, EventRegistrationToken* permission_token,
      EventRegistrationToken* download_token) {
    webview->add_PermissionRequested(
        Callback<ICoreWebView2PermissionRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) {
              args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
              return S_OK;
            })
            .Get(),
        permission_token);
    ComPtr<ICoreWebView2_4> webview4;
    if (FAILED(webview->QueryInterface(IID_PPV_ARGS(&webview4))) || !webview4) {
      return;
    }
    webview4->add_DownloadStarting(
        Callback<ICoreWebView2DownloadStartingEventHandler>(
            [identifier = identifier_](
                ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* args) {
              ComPtr<ICoreWebView2DownloadOperation> operation;
              if (FAILED(args->get_DownloadOperation(&operation)) ||
                  !operation) {
                return S_OK;
              }
              LPWSTR raw_path = nullptr;
              operation->get_ResultFilePath(&raw_path);
              const std::string path = Utf8(TakeWideString(raw_path));
              const size_t separator = path.find_last_of("\\/");
              EmitEvent(
                  identifier, "downloadStarted",
                  {{"filename", separator == std::string::npos
                                    ? path
                                    : path.substr(separator + 1)}});
              auto token = std::make_shared<EventRegistrationToken>();
              operation->add_StateChanged(
                  Callback<ICoreWebView2StateChangedEventHandler>(
                      [identifier, operation,
                       token](IUnknown*, IUnknown*) {
                        COREWEBVIEW2_DOWNLOAD_STATE state =
                            COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
                        operation->get_State(&state);
                        if (state ==
                            COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS) {
                          return S_OK;
                        }
                        operation->remove_StateChanged(*token);
                        if (state ==
                            COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED) {
                          EmitEvent(identifier, "downloadCompleted");
                        } else {
                          EmitEvent(identifier, "downloadFailed",
                                    {{"reason", "interrupted"}});
                        }
                        return S_OK;
                      })
                      .Get(),
                  token.get());
              return S_OK;
            })
            .Get(),
        download_token);
  }

  void RegisterEvents() {
    webview_->add_NavigationCompleted(
        Callback<ICoreWebView2NavigationCompletedEventHandler>(
            [identifier = identifier_](ICoreWebView2* sender,
                                       ICoreWebView2NavigationCompletedEventArgs*
                                           arguments) {
              BOOL succeeded = FALSE;
              arguments->get_IsSuccess(&succeeded);
              LPWSTR raw_source = nullptr;
              sender->get_Source(&raw_source);
              const std::string url = Utf8(TakeWideString(raw_source));
              if (succeeded) {
                EmitEvent(identifier, "navigationCompleted", {{"url", url}});
              } else {
                COREWEBVIEW2_WEB_ERROR_STATUS status =
                    COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
                arguments->get_WebErrorStatus(&status);
                EmitEvent(identifier, "navigationFailed",
                          {{"url", url},
                           {"errorCode", std::to_string(static_cast<int>(status))}});
              }
              return S_OK;
            })
            .Get(),
        &navigation_token_);
    webview_->add_ProcessFailed(
        Callback<ICoreWebView2ProcessFailedEventHandler>(
            [identifier = identifier_](
                ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* arguments) {
              COREWEBVIEW2_PROCESS_FAILED_KIND kind =
                  COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
              arguments->get_ProcessFailedKind(&kind);
              EmitEvent(identifier, "crashed",
                        {{"reason", std::to_string(static_cast<int>(kind))}});
              return S_OK;
            })
            .Get(),
        &process_failed_token_);
    webview_->add_NewWindowRequested(
        Callback<ICoreWebView2NewWindowRequestedEventHandler>(
            [weak = weak_from_this()](
                ICoreWebView2*,
                ICoreWebView2NewWindowRequestedEventArgs* arguments) {
              if (const auto self = weak.lock()) self->CreatePopup(arguments);
              return S_OK;
            })
            .Get(),
        &new_window_token_);
    webview_->add_WebMessageReceived(
        Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [identifier = identifier_](
                ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* arguments) {
              LPWSTR raw_message = nullptr;
              if (SUCCEEDED(arguments->get_WebMessageAsJson(&raw_message))) {
                EmitEvent(identifier, "bridgeMessage",
                          {{"messageJson", Utf8(TakeWideString(raw_message))}});
              }
              return S_OK;
            })
            .Get(),
        &web_message_token_);
    ComPtr<ICoreWebView2_8> audio;
    if (SUCCEEDED(webview_.As(&audio)) && audio) {
      audio->add_IsDocumentPlayingAudioChanged(
          Callback<ICoreWebView2IsDocumentPlayingAudioChangedEventHandler>(
              [weak = weak_from_this()](ICoreWebView2* sender, IUnknown*) {
                ComPtr<ICoreWebView2_8> current;
                BOOL audible = FALSE;
                if (SUCCEEDED(sender->QueryInterface(IID_PPV_ARGS(&current))) &&
                    current) {
                  current->get_IsDocumentPlayingAudio(&audible);
                }
                if (const auto self = weak.lock()) {
                  self->PublishAudibleState(sender, audible == TRUE);
                }
                return S_OK;
              })
              .Get(),
          &audio_token_);
    }
    audible_states_[webview_.Get()] = false;
    RegisterSecurityAndDownloads(
        webview_.Get(), &permission_token_, &download_token_);
  }

  void FailInitialization(HRESULT error) {
    if (failed_ || destroyed_) return;
    failed_ = true;
    initialization_error_ = HResultMessage(error);
    EmitEvent(identifier_, "crashed", {{"reason", initialization_error_}});
    FailPending(initialization_error_);
  }

  void FailPending(const std::string& message) {
    auto pending = std::move(pending_);
    pending_.clear();
    for (auto& item : pending) {
      if (item.failure) item.failure(message);
    }
  }

  int64_t identifier_;
  HWND parent_ = nullptr;
  std::wstring user_data_folder_;
  std::wstring proxy_server_;
  bool destroyed_ = false;
  bool failed_ = false;
  bool ready_ = false;
  bool request_rewrites_configured_ = false;
  bool audio_muted_ = false;
  bool visible_ = false;
  double zoom_factor_ = 1.0;
  RECT bounds_{0, 0, 1, 1};
  std::string initialization_error_;
  std::vector<PendingReadyAction> pending_;
  std::vector<std::wstring> document_start_scripts_;
  std::vector<std::unique_ptr<PopupWebView>> popups_;
  std::vector<RequestRewriteRule> request_rewrites_;
  std::unordered_map<ICoreWebView2*, bool> audible_states_;
  ComPtr<ICoreWebView2Environment> environment_;
  ComPtr<ICoreWebView2EnvironmentOptions> environment_options_;
  ComPtr<ICoreWebView2Controller> controller_;
  ComPtr<ICoreWebView2> webview_;
  EventRegistrationToken navigation_token_{};
  EventRegistrationToken process_failed_token_{};
  EventRegistrationToken new_window_token_{};
  EventRegistrationToken web_message_token_{};
  EventRegistrationToken audio_token_{};
  EventRegistrationToken download_token_{};
  EventRegistrationToken permission_token_{};
  EventRegistrationToken web_resource_requested_token_{};
};

napi_value GetNamed(napi_env env, napi_value object, const char* name) {
  napi_value value;
  if (!Check(env, napi_get_named_property(env, object, name, &value),
             "Invalid WebView2 argument.")) {
    return nullptr;
  }
  return value;
}

std::string GetString(napi_env env, napi_value value, const char* message) {
  size_t length = 0;
  if (!Check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length),
             message)) {
    return {};
  }
  std::vector<char> bytes(length + 1);
  if (!Check(env, napi_get_value_string_utf8(env, value, bytes.data(),
                                             bytes.size(), &length),
             message)) {
    return {};
  }
  return std::string(bytes.data(), length);
}

std::optional<std::string> GetOptionalString(napi_env env, napi_value object,
                                             const char* name) {
  bool present = false;
  if (napi_has_named_property(env, object, name, &present) != napi_ok ||
      !present) {
    return std::nullopt;
  }
  napi_value value = GetNamed(env, object, name);
  napi_valuetype type = napi_undefined;
  if (!value || napi_typeof(env, value, &type) != napi_ok ||
      type != napi_string) {
    return std::nullopt;
  }
  return GetString(env, value, "Invalid WebView2 string property.");
}

std::optional<std::vector<RequestRewriteRule>> GetRequestRewriteRules(
    napi_env env, napi_value value) {
  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) {
    Throw(env, "WebView2 request rewrite rules must be an array.");
    return std::nullopt;
  }
  uint32_t length = 0;
  if (napi_get_array_length(env, value, &length) != napi_ok || length > 32) {
    Throw(env, "WebView2 request rewrite rule count is invalid.");
    return std::nullopt;
  }
  std::vector<RequestRewriteRule> rules;
  rules.reserve(length);
  try {
    for (uint32_t index = 0; index < length; ++index) {
      napi_value item;
      if (napi_get_element(env, value, index, &item) != napi_ok) {
        Throw(env, "A WebView2 request rewrite rule is invalid.");
        return std::nullopt;
      }
      const std::wstring regex_filter = Wide(GetString(
          env, GetNamed(env, item, "regexFilter"),
          "A WebView2 request rewrite regex is required."));
      const std::wstring substitution = Wide(GetString(
          env, GetNamed(env, item, "regexSubstitution"),
          "A WebView2 request rewrite substitution is required."));
      const std::wstring source_host = Wide(GetString(
          env, GetNamed(env, item, "sourceHost"),
          "A WebView2 request rewrite source host is required."));
      if (regex_filter.empty() || substitution.empty() ||
          source_host.empty() ||
          !std::all_of(source_host.begin(), source_host.end(), [](wchar_t ch) {
            return (ch >= L'a' && ch <= L'z') ||
                   (ch >= L'A' && ch <= L'Z') ||
                   (ch >= L'0' && ch <= L'9') || ch == L'.' || ch == L'-';
          })) {
        Throw(env, "A WebView2 request rewrite rule is unsafe.");
        return std::nullopt;
      }
      rules.push_back({
          std::wregex(regex_filter,
                      std::regex_constants::ECMAScript |
                          std::regex_constants::optimize),
          substitution,
          source_host,
      });
    }
  } catch (const std::regex_error&) {
    Throw(env, "A WebView2 request rewrite regex is invalid.");
    return std::nullopt;
  }
  return rules;
}

std::optional<bool> GetOptionalBoolean(napi_env env, napi_value object,
                                       const char* name) {
  bool present = false;
  if (napi_has_named_property(env, object, name, &present) != napi_ok ||
      !present) {
    return std::nullopt;
  }
  napi_value value = GetNamed(env, object, name);
  bool result = false;
  if (!value || napi_get_value_bool(env, value, &result) != napi_ok) {
    return std::nullopt;
  }
  return result;
}

std::optional<double> GetOptionalDouble(napi_env env, napi_value object,
                                       const char* name) {
  bool present = false;
  if (napi_has_named_property(env, object, name, &present) != napi_ok ||
      !present) {
    return std::nullopt;
  }
  napi_value value = GetNamed(env, object, name);
  double result = 0;
  if (!value || napi_get_value_double(env, value, &result) != napi_ok) {
    return std::nullopt;
  }
  return result;
}

int64_t GetSurfaceId(napi_env env, napi_value value) {
  int64_t identifier = 0;
  if (!Check(env, napi_get_value_int64(env, value, &identifier),
             "Expected a WebView2 surface identifier.")) {
    return 0;
  }
  return identifier;
}

std::shared_ptr<WebView2Surface> GetSurface(napi_env env, napi_value value) {
  const int64_t identifier = GetSurfaceId(env, value);
  const auto iterator = surfaces.find(identifier);
  if (identifier == 0 || iterator == surfaces.end()) {
    Throw(env, "The WebView2 surface no longer exists.");
    return {};
  }
  return iterator->second->surface;
}

HWND GetNativeWindow(napi_env env, napi_value value) {
  void* buffer = nullptr;
  size_t length = 0;
  if (!Check(env, napi_get_buffer_info(env, value, &buffer, &length),
             "Expected Electron's native HWND handle.") ||
      length < sizeof(uintptr_t)) {
    Throw(env, "Electron returned an invalid native HWND handle.");
    return nullptr;
  }
  uintptr_t raw = 0;
  std::memcpy(&raw, buffer, sizeof(raw));
  return reinterpret_cast<HWND>(raw);
}

std::wstring CookieDomainFromUrl(const std::string& url) {
  const size_t scheme = url.find("://");
  if (scheme == std::string::npos) return {};
  const size_t start = scheme + 3;
  const size_t end = url.find_first_of("/:?#", start);
  return Wide(url.substr(start, end == std::string::npos ? end : end - start));
}

std::vector<CookieInput> ParseCookies(napi_env env, napi_value value) {
  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) {
    Throw(env, "WebView2 cookies must be an array.");
    return {};
  }
  uint32_t length = 0;
  napi_get_array_length(env, value, &length);
  std::vector<CookieInput> cookies;
  cookies.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    if (napi_get_element(env, value, index, &item) != napi_ok) continue;
    CookieInput cookie;
    cookie.name = Wide(GetString(env, GetNamed(env, item, "name"),
                                 "Cookie name is required."));
    cookie.value = Wide(GetString(env, GetNamed(env, item, "value"),
                                  "Cookie value is required."));
    const auto url = GetOptionalString(env, item, "url").value_or("");
    cookie.domain = Wide(GetOptionalString(env, item, "domain").value_or(""));
    if (cookie.domain.empty()) cookie.domain = CookieDomainFromUrl(url);
    cookie.path = Wide(GetOptionalString(env, item, "path").value_or("/"));
    cookie.expiration_date = GetOptionalDouble(env, item, "expirationDate");
    cookie.http_only = GetOptionalBoolean(env, item, "httpOnly").value_or(false);
    cookie.secure = GetOptionalBoolean(env, item, "secure").value_or(
        url.starts_with("https://"));
    const auto same_site =
        GetOptionalString(env, item, "sameSite").value_or("unspecified");
    if (same_site == "lax") {
      cookie.same_site = COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX;
    } else if (same_site == "strict") {
      cookie.same_site = COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT;
    } else {
      cookie.same_site = COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE;
    }
    if (cookie.name.empty() || cookie.domain.empty()) {
      Throw(env, "A WebView2 cookie requires a name and domain.");
      return {};
    }
    cookies.push_back(std::move(cookie));
  }
  return cookies;
}

std::string CookiesJson(ICoreWebView2CookieList* list) {
  UINT32 count = 0;
  if (!list || FAILED(list->get_Count(&count))) return "[]";
  std::ostringstream json;
  json << "[";
  bool first = true;
  for (UINT32 index = 0; index < count; ++index) {
    ComPtr<ICoreWebView2Cookie> cookie;
    if (FAILED(list->GetValueAtIndex(index, &cookie)) || !cookie) continue;
    LPWSTR raw_name = nullptr;
    LPWSTR raw_value = nullptr;
    LPWSTR raw_domain = nullptr;
    LPWSTR raw_path = nullptr;
    cookie->get_Name(&raw_name);
    cookie->get_Value(&raw_value);
    cookie->get_Domain(&raw_domain);
    cookie->get_Path(&raw_path);
    const std::string name = Utf8(TakeWideString(raw_name));
    const std::string value = Utf8(TakeWideString(raw_value));
    const std::string domain = Utf8(TakeWideString(raw_domain));
    const std::string path = Utf8(TakeWideString(raw_path));
    BOOL secure = FALSE;
    BOOL http_only = FALSE;
    BOOL session = TRUE;
    double expires = 0;
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND same_site =
        COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE;
    cookie->get_IsSecure(&secure);
    cookie->get_IsHttpOnly(&http_only);
    cookie->get_IsSession(&session);
    cookie->get_Expires(&expires);
    cookie->get_SameSite(&same_site);
    if (!first) json << ",";
    first = false;
    const std::string normalized_domain =
        !domain.empty() && domain.front() == '.' ? domain.substr(1) : domain;
    json << "{\"name\":\"" << JsonEscape(name) << "\",\"value\":\""
         << JsonEscape(value) << "\",\"domain\":\"" << JsonEscape(domain)
         << "\",\"path\":\"" << JsonEscape(path)
         << "\",\"url\":\"" << (secure ? "https" : "http") << "://"
         << JsonEscape(normalized_domain) << JsonEscape(path)
         << "\",\"secure\":" << (secure ? "true" : "false")
         << ",\"httpOnly\":" << (http_only ? "true" : "false")
         << ",\"sameSite\":\""
         << (same_site == COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX
                 ? "lax"
                 : same_site == COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT
                       ? "strict"
                       : "unspecified")
         << "\"";
    if (!session && std::isfinite(expires) && expires > 0) {
      json << ",\"expirationDate\":" << expires;
    }
    json << "}";
  }
  json << "]";
  return json.str();
}

napi_value CreateSurface(napi_env env, napi_callback_info info) {
  const HRESULT com_result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(com_result) && com_result != RPC_E_CHANGED_MODE) {
    Throw(env, "Unable to initialize COM for the WebView2 adapter.");
    return nullptr;
  }
  size_t argc = 3;
  napi_value args[3];
  if (!Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr),
             "Unable to read WebView2 arguments.") ||
      argc != 3) {
    Throw(env, "createWebView2Surface requires a handle, options, and callback.");
    return nullptr;
  }
  const HWND parent = GetNativeWindow(env, args[0]);
  if (!parent || !IsWindow(parent)) {
    Throw(env, "The native WebView2 parent HWND is invalid.");
    return nullptr;
  }
  const std::wstring user_data_folder =
      Wide(GetString(env, GetNamed(env, args[1], "userDataFolder"),
                     "A WebView2 user-data folder is required."));
  const std::wstring proxy_server =
      Wide(GetString(env, GetNamed(env, args[1], "proxyServer"),
                     "The WebView2 proxy server is invalid."));
  napi_valuetype callback_type = napi_undefined;
  napi_typeof(env, args[2], &callback_type);
  if (callback_type != napi_function) {
    Throw(env, "The WebView2 event callback must be a function.");
    return nullptr;
  }
  const int64_t identifier = next_surface_id++;
  auto record = std::make_unique<SurfaceRecord>();
  if (!Check(env, napi_create_reference(env, args[2], 1, &record->callback),
             "Unable to retain the WebView2 callback.")) {
    return nullptr;
  }
  record->surface =
      std::make_shared<WebView2Surface>(identifier, parent, user_data_folder,
                                        proxy_server);
  const auto surface = record->surface;
  surfaces.emplace(identifier, std::move(record));
  const HRESULT result = surface->Initialize();
  if (FAILED(result)) {
    const auto failed = surfaces.find(identifier);
    if (failed != surfaces.end() && failed->second->callback) {
      napi_delete_reference(env, failed->second->callback);
    }
    surfaces.erase(identifier);
    Throw(env, "WebView2 environment creation could not be started.");
    return nullptr;
  }
  napi_value output;
  napi_create_int64(env, identifier, &output);
  return output;
}

napi_value DestroySurface(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1) {
    Throw(env, "destroyWebView2Surface requires a surface identifier.");
    return nullptr;
  }
  const int64_t identifier = GetSurfaceId(env, args[0]);
  const auto iterator = surfaces.find(identifier);
  if (iterator == surfaces.end()) return Undefined(env);
  iterator->second->surface->Destroy();
  napi_delete_reference(env, iterator->second->callback);
  surfaces.erase(iterator);
  return Undefined(env);
}

napi_value LoadUrl(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 2 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  const std::wstring url =
      Wide(GetString(env, args[1], "A WebView2 URL is required."));
  const int64_t identifier = GetSurfaceId(env, args[0]);
  surface->WhenReady(
      [surface, url] { surface->webview()->Navigate(url.c_str()); },
      [identifier, url](const std::string& error) {
        EmitEvent(identifier, "navigationFailed",
                  {{"url", Utf8(url)}, {"errorCode", error}});
      });
  return Undefined(env);
}

napi_value Evaluate(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 3 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  const int64_t identifier = GetSurfaceId(env, args[0]);
  const std::string request_id =
      GetString(env, args[1], "A WebView2 request id is required.");
  const std::wstring source =
      Wide(GetString(env, args[2], "WebView2 script source is required."));
  surface->WhenReady(
      [surface, identifier, request_id, source] {
        const HRESULT result = surface->webview()->ExecuteScript(
            source.c_str(),
            Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
                [identifier, request_id](HRESULT error, LPCWSTR value) {
                  if (FAILED(error)) {
                    EmitEvent(identifier, "evaluationCompleted",
                              {{"requestId", request_id},
                               {"error", HResultMessage(error)}});
                  } else {
                    EmitEvent(identifier, "evaluationCompleted",
                              {{"requestId", request_id},
                               {"valueJson", Utf8(value ? value : L"null")}});
                  }
                  return S_OK;
                })
                .Get());
        if (FAILED(result)) {
          EmitEvent(identifier, "evaluationCompleted",
                    {{"requestId", request_id},
                     {"error", HResultMessage(result)}});
        }
      },
      [identifier, request_id](const std::string& error) {
        EmitEvent(identifier, "evaluationCompleted",
                  {{"requestId", request_id}, {"error", error}});
      });
  return Undefined(env);
}

napi_value AddDocumentStartScript(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 3 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  const int64_t identifier = GetSurfaceId(env, args[0]);
  const std::string request_id =
      GetString(env, args[1], "A document-start request id is required.");
  const std::wstring source =
      Wide(GetString(env, args[2], "A document-start script is required."));
  if (source.empty()) {
    EmitEvent(identifier, "documentStartScriptAdded",
              {{"requestId", request_id},
               {"error", "The document-start script is empty."}});
    return Undefined(env);
  }
  surface->WhenReady(
      [surface, identifier, request_id, source] {
        const HRESULT result =
            surface->webview()->AddScriptToExecuteOnDocumentCreated(
                source.c_str(),
                Callback<
                    ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>(
                    [surface, identifier, request_id,
                     source](HRESULT error, LPCWSTR) {
                      if (SUCCEEDED(error)) {
                        surface->RememberDocumentStartScript(source);
                      }
                      EmitEvent(
                          identifier, "documentStartScriptAdded",
                          FAILED(error)
                              ? std::vector<
                                    std::pair<std::string, std::string>>{
                                    {"requestId", request_id},
                                    {"error", HResultMessage(error)}}
                              : std::vector<
                                    std::pair<std::string, std::string>>{
                                    {"requestId", request_id}});
                      return S_OK;
                    })
                    .Get());
        if (FAILED(result)) {
          EmitEvent(identifier, "documentStartScriptAdded",
                    {{"requestId", request_id},
                     {"error", HResultMessage(result)}});
        }
      },
      [identifier, request_id](const std::string& error) {
        EmitEvent(identifier, "documentStartScriptAdded",
                  {{"requestId", request_id}, {"error", error}});
      });
  return Undefined(env);
}

napi_value ConfigureRequestRewrites(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 3 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  const int64_t identifier = GetSurfaceId(env, args[0]);
  const std::string request_id =
      GetString(env, args[1], "A request-rewrite request id is required.");
  auto rules = GetRequestRewriteRules(env, args[2]);
  if (!rules) return nullptr;
  surface->WhenReady(
      [surface, identifier, request_id, rules = std::move(*rules)]() mutable {
        const HRESULT result =
            surface->ConfigureRequestRewrites(std::move(rules));
        EmitEvent(
            identifier, "requestRewritesConfigured",
            FAILED(result)
                ? std::vector<std::pair<std::string, std::string>>{
                      {"requestId", request_id},
                      {"error", HResultMessage(result)}}
                : std::vector<std::pair<std::string, std::string>>{
                      {"requestId", request_id}});
      },
      [identifier, request_id](const std::string& error) {
        EmitEvent(identifier, "requestRewritesConfigured",
                  {{"requestId", request_id}, {"error", error}});
      });
  return Undefined(env);
}

napi_value CallDevTools(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 4 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  const int64_t identifier = GetSurfaceId(env, args[0]);
  const std::string request_id =
      GetString(env, args[1], "A WebView2 request id is required.");
  const std::wstring method =
      Wide(GetString(env, args[2], "A CDP method is required."));
  const std::wstring parameters =
      Wide(GetString(env, args[3], "CDP parameters JSON is required."));
  surface->WhenReady(
      [surface, identifier, request_id, method, parameters] {
        const HRESULT result = surface->webview()->CallDevToolsProtocolMethod(
            method.c_str(), parameters.c_str(),
            Callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler>(
                [identifier, request_id](HRESULT error, LPCWSTR value) {
                  EmitEvent(
                      identifier, "devToolsCompleted",
                      FAILED(error)
                          ? std::vector<std::pair<std::string, std::string>>{
                                {"requestId", request_id},
                                {"error", HResultMessage(error)}}
                          : std::vector<std::pair<std::string, std::string>>{
                                {"requestId", request_id},
                                {"valueJson", Utf8(value ? value : L"{}")}});
                  return S_OK;
                })
                .Get());
        if (FAILED(result)) {
          EmitEvent(identifier, "devToolsCompleted",
                    {{"requestId", request_id},
                     {"error", HResultMessage(result)}});
        }
      },
      [identifier, request_id](const std::string& error) {
        EmitEvent(identifier, "devToolsCompleted",
                  {{"requestId", request_id}, {"error", error}});
      });
  return Undefined(env);
}

napi_value ClearData(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 2 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  const int64_t identifier = GetSurfaceId(env, args[0]);
  const std::string request_id =
      GetString(env, args[1], "A WebView2 request id is required.");
  surface->WhenReady(
      [surface, identifier, request_id] {
        ComPtr<ICoreWebView2_13> webview13;
        ComPtr<ICoreWebView2Profile> profile;
        ComPtr<ICoreWebView2Profile2> profile2;
        HRESULT result = surface->webview()->QueryInterface(IID_PPV_ARGS(&webview13));
        if (SUCCEEDED(result) && webview13) result = webview13->get_Profile(&profile);
        if (SUCCEEDED(result) && profile) result = profile.As(&profile2);
        if (FAILED(result) || !profile2) {
          EmitEvent(identifier, "websiteDataCleared",
                    {{"requestId", request_id},
                     {"error", "The WebView2 Runtime does not expose profile data clearing."}});
          return;
        }
        result = profile2->ClearBrowsingDataAll(
            Callback<ICoreWebView2ClearBrowsingDataCompletedHandler>(
                [identifier, request_id](HRESULT error) {
                  EmitEvent(
                      identifier, "websiteDataCleared",
                      FAILED(error)
                          ? std::vector<std::pair<std::string, std::string>>{
                                {"requestId", request_id},
                                {"error", HResultMessage(error)}}
                          : std::vector<std::pair<std::string, std::string>>{
                                {"requestId", request_id}});
                  return S_OK;
                })
                .Get());
        if (FAILED(result)) {
          EmitEvent(identifier, "websiteDataCleared",
                    {{"requestId", request_id},
                     {"error", HResultMessage(result)}});
        }
      },
      [identifier, request_id](const std::string& error) {
        EmitEvent(identifier, "websiteDataCleared",
                  {{"requestId", request_id}, {"error", error}});
      });
  return Undefined(env);
}

napi_value GetCookies(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 2 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  const int64_t identifier = GetSurfaceId(env, args[0]);
  const std::string request_id =
      GetString(env, args[1], "A WebView2 request id is required.");
  surface->WhenReady(
      [surface, identifier, request_id] {
        ComPtr<ICoreWebView2_2> webview2;
        ComPtr<ICoreWebView2CookieManager> manager;
        HRESULT result =
            surface->webview()->QueryInterface(IID_PPV_ARGS(&webview2));
        if (SUCCEEDED(result) && webview2) {
          result = webview2->get_CookieManager(&manager);
        }
        if (FAILED(result) || !manager) {
          EmitEvent(identifier, "cookiesRead",
                    {{"requestId", request_id},
                     {"cookiesJson", "[]"},
                     {"error", HResultMessage(result)}});
          return;
        }
        result = manager->GetCookies(
            nullptr,
            Callback<ICoreWebView2GetCookiesCompletedHandler>(
                [identifier, request_id](HRESULT error,
                                         ICoreWebView2CookieList* cookies) {
                  if (FAILED(error)) {
                    EmitEvent(identifier, "cookiesRead",
                              {{"requestId", request_id},
                               {"cookiesJson", "[]"},
                               {"error", HResultMessage(error)}});
                  } else {
                    EmitEvent(identifier, "cookiesRead",
                              {{"requestId", request_id},
                               {"cookiesJson", CookiesJson(cookies)}});
                  }
                  return S_OK;
                })
                .Get());
        if (FAILED(result)) {
          EmitEvent(identifier, "cookiesRead",
                    {{"requestId", request_id},
                     {"cookiesJson", "[]"},
                     {"error", HResultMessage(result)}});
        }
      },
      [identifier, request_id](const std::string& error) {
        EmitEvent(identifier, "cookiesRead",
                  {{"requestId", request_id},
                   {"cookiesJson", "[]"},
                   {"error", error}});
      });
  return Undefined(env);
}

napi_value SetCookies(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 3 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  const int64_t identifier = GetSurfaceId(env, args[0]);
  const std::string request_id =
      GetString(env, args[1], "A WebView2 request id is required.");
  const std::vector<CookieInput> cookies = ParseCookies(env, args[2]);
  bool pending_exception = false;
  napi_is_exception_pending(env, &pending_exception);
  if (pending_exception) return nullptr;
  surface->WhenReady(
      [surface, identifier, request_id, cookies] {
        ComPtr<ICoreWebView2_2> webview2;
        ComPtr<ICoreWebView2CookieManager> manager;
        HRESULT result =
            surface->webview()->QueryInterface(IID_PPV_ARGS(&webview2));
        if (SUCCEEDED(result) && webview2) {
          result = webview2->get_CookieManager(&manager);
        }
        uint32_t migrated = 0;
        if (SUCCEEDED(result) && manager) {
          for (const auto& input : cookies) {
            ComPtr<ICoreWebView2Cookie> cookie;
            result = manager->CreateCookie(
                input.name.c_str(), input.value.c_str(), input.domain.c_str(),
                input.path.c_str(), &cookie);
            if (FAILED(result) || !cookie) break;
            cookie->put_IsHttpOnly(input.http_only ? TRUE : FALSE);
            cookie->put_IsSecure(input.secure ? TRUE : FALSE);
            cookie->put_SameSite(input.same_site);
            if (input.expiration_date.has_value()) {
              cookie->put_Expires(*input.expiration_date);
            }
            result = manager->AddOrUpdateCookie(cookie.Get());
            if (FAILED(result)) break;
            ++migrated;
          }
        }
        EmitEvent(
            identifier, "cookiesWritten",
            FAILED(result)
                ? std::vector<std::pair<std::string, std::string>>{
                      {"requestId", request_id},
                      {"error", HResultMessage(result)}}
                : std::vector<std::pair<std::string, std::string>>{
                      {"requestId", request_id}},
            {}, {{"count", static_cast<double>(migrated)}});
      },
      [identifier, request_id](const std::string& error) {
        EmitEvent(identifier, "cookiesWritten",
                  {{"requestId", request_id}, {"error", error}});
      });
  return Undefined(env);
}

napi_value SetBounds(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 2 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  const auto number = [env, object = args[1]](const char* name) {
    double value = 0;
    napi_get_value_double(env, GetNamed(env, object, name), &value);
    return static_cast<LONG>(std::lround(value));
  };
  const LONG x = number("x");
  const LONG y = number("y");
  const LONG width = std::max<LONG>(1, number("width"));
  const LONG height = std::max<LONG>(1, number("height"));
  surface->SetBounds({x, y, x + width, y + height});
  return Undefined(env);
}

napi_value SetVisible(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 2 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  bool visible = false;
  napi_get_value_bool(env, args[1], &visible);
  surface->SetVisible(visible);
  return Undefined(env);
}

napi_value SetZoom(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 2 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  double factor = 1;
  napi_get_value_double(env, args[1], &factor);
  surface->SetZoom(std::clamp(factor, 0.25, 5.0));
  return Undefined(env);
}

napi_value Focus(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 1 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  surface->WhenReady([surface] { surface->Focus(); });
  return Undefined(env);
}

napi_value SetMuted(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  const auto surface = argc == 2 ? GetSurface(env, args[0]) : nullptr;
  if (!surface) return nullptr;
  bool muted = false;
  napi_get_value_bool(env, args[1], &muted);
  napi_value result;
  napi_get_boolean(env, surface->SetMuted(muted), &result);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  addon_env = env;
  napi_value version;
  napi_create_int32(env, kProtocolVersion, &version);
  napi_set_named_property(env, exports, "protocolVersion", version);
  const napi_property_descriptor properties[] = {
      {"createWebView2Surface", nullptr, CreateSurface, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"destroyWebView2Surface", nullptr, DestroySurface, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"loadWebView2URL", nullptr, LoadUrl, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"evaluateWebView2", nullptr, Evaluate, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"addWebView2DocumentStartScript", nullptr, AddDocumentStartScript,
       nullptr, nullptr, nullptr, napi_default, nullptr},
      {"configureWebView2RequestRewrites", nullptr, ConfigureRequestRewrites,
       nullptr, nullptr, nullptr, napi_default, nullptr},
      {"callWebView2DevToolsMethod", nullptr, CallDevTools, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"clearWebView2Data", nullptr, ClearData, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"getWebView2Cookies", nullptr, GetCookies, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"setWebView2Cookies", nullptr, SetCookies, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"setWebView2Bounds", nullptr, SetBounds, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"setWebView2Visible", nullptr, SetVisible, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"setWebView2Zoom", nullptr, SetZoom, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"focusWebView2", nullptr, Focus, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"setWebView2AudioMuted", nullptr, SetMuted, nullptr, nullptr, nullptr,
       napi_default, nullptr}};
  napi_define_properties(env, exports,
                         sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

#import <Foundation/Foundation.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>

void *rion_wk_create_role_network_configuration(
    const uint8_t *dataStoreIdentifierBytes) {
  @autoreleasepool {
    if (!dataStoreIdentifierBytes) return NULL;
    @try {
      uuid_t identifierBytes;
      memcpy(identifierBytes, dataStoreIdentifierBytes, sizeof(identifierBytes));
      NSUUID *identifier = [[NSUUID alloc] initWithUUIDBytes:identifierBytes];
      WKWebsiteDataStore *dataStore =
          [WKWebsiteDataStore dataStoreForIdentifier:identifier];
      WKWebViewConfiguration *configuration =
          [[WKWebViewConfiguration alloc] init];
      configuration.websiteDataStore = dataStore;
      return (__bridge_retained void *)configuration;
    } @catch (__unused NSException *exception) {
      return NULL;
    }
  }
}

bool rion_wk_apply_proxy(void *rawConfiguration,
                         const char *protocol,
                         const char *host,
                         uint16_t port) {
  @autoreleasepool {
    if (!rawConfiguration) return false;
    if (@available(macOS 14.0, *)) {
      @try {
        WKWebViewConfiguration *configuration =
            (__bridge WKWebViewConfiguration *)rawConfiguration;
        WKWebsiteDataStore *dataStore = configuration.websiteDataStore;
        if (!dataStore) return false;
        if (!protocol) {
          dataStore.proxyConfigurations = nil;
          return true;
        }
        if (!host || port == 0) return false;
        NSString *portString = [NSString stringWithFormat:@"%u", port];
        nw_endpoint_t endpoint =
            nw_endpoint_create_host(host, portString.UTF8String);
        if (!endpoint) return false;
        nw_proxy_config_t proxy = NULL;
        if (strcmp(protocol, "http") == 0) {
          proxy = nw_proxy_config_create_http_connect(endpoint, NULL);
        } else if (strcmp(protocol, "socks5") == 0) {
          proxy = nw_proxy_config_create_socksv5(endpoint);
        } else {
          return false;
        }
        if (!proxy) return false;
        nw_proxy_config_set_failover_allowed(proxy, false);
        dataStore.proxyConfigurations = @[proxy];
        return true;
      } @catch (__unused NSException *exception) {
        return false;
      }
    }
    return false;
  }
}

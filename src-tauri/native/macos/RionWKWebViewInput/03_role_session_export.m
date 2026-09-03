#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#import <dispatch/dispatch.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <uuid/uuid.h>

enum {
  RionWKRoleSessionPublicEvidenceObserved = 0,
  RionWKRoleSessionPublicEvidenceFailed = 1,
};

typedef void (*RionWKRoleSessionPublicEvidenceCallback)(
    void *context, int32_t status, uint64_t cookieCount,
    uint64_t httpOnlyCookieCount, uint64_t localStorageRecordCount);

@interface RionWKRoleSessionPublicEvidenceProbe : NSObject
@property(nonatomic, strong) WKWebsiteDataStore *dataStore;
@property(nonatomic, assign) void *context;
@property(nonatomic, assign) RionWKRoleSessionPublicEvidenceCallback callback;
@property(nonatomic, assign) RionWKSurfaceContextDestructor contextDestructor;
@property(nonatomic, assign) NSUInteger pendingObservationCount;
@property(nonatomic, assign) uint64_t cookieCount;
@property(nonatomic, assign) uint64_t httpOnlyCookieCount;
@property(nonatomic, assign) uint64_t localStorageRecordCount;
@property(nonatomic, assign) BOOL delivered;
- (void)recordCookies:(NSArray<NSHTTPCookie *> *)cookies;
- (void)recordLocalStorageRecords:(NSArray<WKWebsiteDataRecord *> *)records;
- (void)failObservation;
@end

@implementation RionWKRoleSessionPublicEvidenceProbe
- (void)finishWithStatus:(int32_t)status {
  if (_delivered) return;
  _delivered = YES;
  void *context = _context;
  RionWKRoleSessionPublicEvidenceCallback callback = _callback;
  RionWKSurfaceContextDestructor contextDestructor = _contextDestructor;
  _context = NULL;
  _callback = NULL;
  _contextDestructor = NULL;
  _dataStore = nil;
  if (callback && context) {
    callback(context, status, _cookieCount, _httpOnlyCookieCount,
             _localStorageRecordCount);
  }
  if (contextDestructor && context) contextDestructor(context);
}

- (void)finishIfComplete {
  if (_pendingObservationCount == 0) {
    [self finishWithStatus:RionWKRoleSessionPublicEvidenceObserved];
  }
}

- (void)recordCookies:(NSArray<NSHTTPCookie *> *)cookies {
  if (![NSThread isMainThread]) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self failObservation];
    });
    return;
  }
  if (_delivered) return;
  @try {
    if (!cookies || _pendingObservationCount == 0) {
      [self failObservation];
      return;
    }
    _cookieCount = (uint64_t)cookies.count;
    uint64_t httpOnlyCount = 0;
    for (NSHTTPCookie *cookie in cookies) {
      if (![cookie isKindOfClass:NSHTTPCookie.class]) {
        [self failObservation];
        return;
      }
      if (cookie.HTTPOnly) httpOnlyCount += 1;
      // Public Foundation properties expose Secure, HTTPOnly, expiry and
      // SameSite. They do not expose a complete host-only, priority, or
      // partition identity, so this probe never serializes cookie values.
      (void)cookie.secure;
      (void)cookie.expiresDate;
      (void)cookie.sameSitePolicy;
    }
    _httpOnlyCookieCount = httpOnlyCount;
    _pendingObservationCount -= 1;
    [self finishIfComplete];
  } @catch (__unused NSException *exception) {
    [self failObservation];
  }
}

- (void)recordLocalStorageRecords:(NSArray<WKWebsiteDataRecord *> *)records {
  if (![NSThread isMainThread]) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self failObservation];
    });
    return;
  }
  if (_delivered) return;
  @try {
    if (!records || _pendingObservationCount == 0) {
      [self failObservation];
      return;
    }
    for (WKWebsiteDataRecord *record in records) {
      if (![record isKindOfClass:WKWebsiteDataRecord.class] ||
          ![record.dataTypes containsObject:WKWebsiteDataTypeLocalStorage]) {
        [self failObservation];
        return;
      }
    }
    // The public record API proves that LocalStorage data exists, but exposes
    // only displayName/dataTypes, never exact origin/key/value inventory.
    _localStorageRecordCount = (uint64_t)records.count;
    _pendingObservationCount -= 1;
    [self finishIfComplete];
  } @catch (__unused NSException *exception) {
    [self failObservation];
  }
}

- (void)failObservation {
  _pendingObservationCount = 0;
  [self finishWithStatus:RionWKRoleSessionPublicEvidenceFailed];
}
@end

bool rion_wk_observe_role_session_public_evidence(
    const uint8_t *dataStoreIdentifierBytes, void *context,
    RionWKRoleSessionPublicEvidenceCallback callback,
    RionWKSurfaceContextDestructor contextDestructor) {
  @autoreleasepool {
    if (!dataStoreIdentifierBytes || !context || !callback ||
        !contextDestructor || ![NSThread isMainThread]) {
      return false;
    }
    if (@available(macOS 14.0, *)) {
      @try {
        uuid_t identifierBytes;
        memcpy(identifierBytes, dataStoreIdentifierBytes,
               sizeof(identifierBytes));
        NSUUID *identifier = [[NSUUID alloc] initWithUUIDBytes:identifierBytes];
        WKWebsiteDataStore *dataStore =
            [WKWebsiteDataStore dataStoreForIdentifier:identifier];
        if (!dataStore || !dataStore.persistent || !dataStore.identifier ||
            ![dataStore.identifier isEqual:identifier]) {
          return false;
        }

        RionWKRoleSessionPublicEvidenceProbe *probe =
            [[RionWKRoleSessionPublicEvidenceProbe alloc] init];
        probe.dataStore = dataStore;
        probe.context = context;
        probe.callback = callback;
        probe.contextDestructor = contextDestructor;
        probe.pendingObservationCount = 2;

        [dataStore.httpCookieStore
            getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
              [probe recordCookies:cookies];
            }];
        [dataStore
            fetchDataRecordsOfTypes:
                [NSSet setWithObject:WKWebsiteDataTypeLocalStorage]
                 completionHandler:^(NSArray<WKWebsiteDataRecord *> *records) {
                   [probe recordLocalStorageRecords:records];
                 }];
        return true;
      } @catch (__unused NSException *exception) {
        return false;
      }
    }
    return false;
  }
}

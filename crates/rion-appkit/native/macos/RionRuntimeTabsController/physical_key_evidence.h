// Passive, per-responder journal. No physical event is forwarded or consumed here.
static NSString *RionChromiumCodeForVirtualKey(unsigned short keyCode);
static char RionPhysicalKeyboardJournalKey;
static char RionPhysicalKeyboardSequenceKey;
static char RionPhysicalKeyboardObservedEventKey;

static void RionRecordPhysicalKeyboardEvent(NSView *target, NSEvent *event, BOOL consumed, BOOL released) {
  if (!target || !event) return;
  // Chromium may redispatch the same NSEvent; observe it once without swallowing it.
  if (objc_getAssociatedObject(event, &RionPhysicalKeyboardObservedEventKey)) return;
  objc_setAssociatedObject(event, &RionPhysicalKeyboardObservedEventKey, @YES,
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  NSMutableArray<NSData *> *journal = objc_getAssociatedObject(target, &RionPhysicalKeyboardJournalKey);
  if (!journal) {
    journal = [NSMutableArray array];
    objc_setAssociatedObject(target, &RionPhysicalKeyboardJournalKey, journal,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  NSNumber *previous = objc_getAssociatedObject(target, &RionPhysicalKeyboardSequenceKey);
  uint64_t sequence = previous.unsignedLongLongValue;
  if (sequence != UINT64_MAX) ++sequence;
  objc_setAssociatedObject(target, &RionPhysicalKeyboardSequenceKey, @(sequence),
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  RionAppKitPhysicalKeyEvent record = {};
  record.sequence = sequence;
  NSString *code = RionChromiumCodeForVirtualKey(event.keyCode);
  std::strncpy(record.code, (code ?: @"Unidentified").UTF8String, sizeof(record.code) - 1);
  record.released = released;
  record.repeat = event.type == NSEventTypeKeyDown && event.isARepeat;
  record.consumed = consumed;
  [journal addObject:[NSData dataWithBytes:&record length:sizeof(record)]];
  if (journal.count > 128) [journal removeObjectAtIndex:0];
}

static void RionReadPhysicalKeyboardEvents(NSView *target,
    RionAppKitChromiumInputSurfaceProbeResult *result) {
  NSNumber *sequence = objc_getAssociatedObject(target, &RionPhysicalKeyboardSequenceKey);
  result->physicalKeyboardSequence = sequence.unsignedLongLongValue;
  NSArray<NSData *> *journal = objc_getAssociatedObject(target, &RionPhysicalKeyboardJournalKey);
  result->physicalKeyEventCount = (uint32_t)MIN(journal.count, 128);
  for (NSUInteger index = 0; index < result->physicalKeyEventCount; ++index) {
    [journal[index] getBytes:&result->physicalKeyEvents[index]
                     length:sizeof(RionAppKitPhysicalKeyEvent)];
  }
}

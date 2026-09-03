#include <errno.h>
#include <libproc.h>
#include <mach/message.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>

#define OWNER_MINIMUM_START_KEY "RION_STUDIO_PACKAGED_PROCESS_MINIMUM_START"
#define OWNER_ROOT_PID_KEY "RION_STUDIO_PACKAGED_PROCESS_ROOT_PID"
#define OWNER_BUNDLE_ROOT_KEY "RION_STUDIO_PACKAGED_PROCESS_BUNDLE_ROOT"
#define OWNER_KNOWN_FENCES_KEY "RION_STUDIO_PACKAGED_PROCESS_KNOWN_FENCES"
#define RION_PROC_PIDT_BSDINFOWITHUNIQID 18
#define RION_MAXIMUM_KNOWN_PROCESS_FENCES 4096

struct rion_proc_uniqidentifierinfo {
  uint8_t executable_uuid[16];
  uint64_t unique_id;
  uint64_t parent_unique_id;
  int32_t id_version;
  uint32_t reserved_2;
  uint64_t reserved_3;
  uint64_t reserved_4;
};

struct rion_proc_bsdinfowithuniqid {
  struct proc_bsdinfo bsd;
  struct rion_proc_uniqidentifierinfo unique;
};

struct rion_known_process_fence {
  uint32_t process_id;
  uint64_t start_seconds;
  uint64_t start_microseconds;
};

_Static_assert(sizeof(struct rion_proc_uniqidentifierinfo) == 56,
               "private process unique-identity ABI changed");
_Static_assert(offsetof(struct rion_proc_uniqidentifierinfo, unique_id) == 16,
               "private process unique-id offset changed");
_Static_assert(offsetof(struct rion_proc_uniqidentifierinfo, id_version) == 32,
               "private process id-version offset changed");
_Static_assert(offsetof(struct rion_proc_bsdinfowithuniqid, unique) ==
                   sizeof(struct proc_bsdinfo),
               "private BSD unique-identity ABI alignment changed");
_Static_assert(sizeof(struct rion_proc_bsdinfowithuniqid) ==
                   sizeof(struct proc_bsdinfo) +
                       sizeof(struct rion_proc_uniqidentifierinfo),
               "private BSD unique-identity ABI size changed");

static void write_hex(const unsigned char *bytes, size_t length) {
  static const char digits[] = "0123456789abcdef";
  for (size_t index = 0; index < length; index += 1) {
    unsigned char value = bytes[index];
    putchar(digits[value >> 4]);
    putchar(digits[value & 0x0f]);
  }
}

static int hex_nibble(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  return -1;
}

static int parse_audit_token(const char *source, audit_token_t *token) {
  size_t byte_count = sizeof(*token);
  if (strlen(source) != byte_count * 2) return -1;
  unsigned char *bytes = (unsigned char *)token;
  for (size_t index = 0; index < byte_count; index += 1) {
    int high = hex_nibble(source[index * 2]);
    int low = hex_nibble(source[index * 2 + 1]);
    if (high < 0 || low < 0) return -1;
    bytes[index] = (unsigned char)((high << 4) | low);
  }
  return 0;
}

static audit_token_t audit_token_for_identity(
    uint32_t process_id,
    int32_t id_version) {
  audit_token_t token = {0};
  token.val[5] = process_id;
  token.val[7] = (uint32_t)id_version;
  return token;
}

static int signal_audit_token(const char *token_source, const char *signal_source) {
  audit_token_t token = {0};
  if (parse_audit_token(token_source, &token) != 0) {
    fprintf(stderr, "invalid audit token\n");
    return 40;
  }
  char *signal_end = NULL;
  errno = 0;
  long signal_value = strtol(signal_source, &signal_end, 10);
  if (errno != 0 || signal_end == signal_source || *signal_end != '\0' ||
      (signal_value != SIGTERM && signal_value != SIGKILL)) {
    fprintf(stderr, "invalid signal\n");
    return 41;
  }
  int result = proc_signal_with_audittoken(&token, (int)signal_value);
  if (result == 0) return 0;
  if (result == ESRCH) return 44;
  fprintf(stderr, "audit-token signal failed: %d\n", result);
  return 42;
}

static int parse_positive_integer(const char *source, uint64_t *result) {
  if (source == NULL || *source == '\0') return -1;
  char *end = NULL;
  errno = 0;
  unsigned long long value = strtoull(source, &end, 10);
  if (errno != 0 || end == source || *end != '\0' || value == 0) return -1;
  *result = (uint64_t)value;
  return 0;
}

static int read_process_identity(
    pid_t process_id,
    struct rion_proc_bsdinfowithuniqid *information) {
  for (int attempt = 0; attempt < 3; attempt += 1) {
    memset(information, 0, sizeof(*information));
    int information_bytes = proc_pidinfo(
        process_id,
        RION_PROC_PIDT_BSDINFOWITHUNIQID,
        0,
        information,
        (int)sizeof(*information));
    if (information_bytes == (int)sizeof(*information) &&
        information->bsd.pbi_pid == (uint32_t)process_id &&
        information->bsd.pbi_uid == getuid() &&
        information->unique.unique_id != 0) {
      return 0;
    }
  }
  return -1;
}

static int parse_known_process_fences(
    const char *source,
    struct rion_known_process_fence *fences,
    size_t *count) {
  *count = 0;
  if (source == NULL || *source == '\0') return 0;
  const char *cursor = source;
  while (*cursor != '\0') {
    if (*count >= RION_MAXIMUM_KNOWN_PROCESS_FENCES) return -1;
    char *end = NULL;
    errno = 0;
    unsigned long long process_id = strtoull(cursor, &end, 10);
    if (errno != 0 || end == cursor || *end != ':' || process_id <= 1 ||
        process_id > UINT32_MAX) {
      return -1;
    }
    cursor = end + 1;
    errno = 0;
    unsigned long long start_seconds = strtoull(cursor, &end, 10);
    if (errno != 0 || end == cursor || *end != ':' || start_seconds == 0) {
      return -1;
    }
    cursor = end + 1;
    errno = 0;
    unsigned long long start_microseconds = strtoull(cursor, &end, 10);
    if (errno != 0 || end == cursor || start_microseconds > 999999 ||
        (*end != ',' && *end != '\0')) {
      return -1;
    }
    fences[*count] = (struct rion_known_process_fence){
        .process_id = (uint32_t)process_id,
        .start_seconds = (uint64_t)start_seconds,
        .start_microseconds = (uint64_t)start_microseconds};
    *count += 1;
    cursor = *end == ',' ? end + 1 : end;
    if (*cursor == '\0') break;
  }
  return 0;
}

static int process_matches_known_fence(
    uint32_t process_id,
    uint64_t start_seconds,
    uint64_t start_microseconds,
    const struct rion_known_process_fence *fences,
    size_t fence_count) {
  for (size_t index = 0; index < fence_count; index += 1) {
    if (fences[index].process_id == process_id &&
        fences[index].start_seconds == start_seconds &&
        fences[index].start_microseconds == start_microseconds) {
      return 1;
    }
  }
  return 0;
}

static int process_id_is_known(
    uint32_t process_id,
    const struct rion_known_process_fence *fences,
    size_t fence_count) {
  for (size_t index = 0; index < fence_count; index += 1) {
    if (fences[index].process_id == process_id) return 1;
  }
  return 0;
}

static int path_is_inside_bundle(const char *path, const char *bundle_root) {
  if (path == NULL || *path == '\0') return 0;
  size_t root_length = strlen(bundle_root);
  return strncmp(path, bundle_root, root_length) == 0 &&
      (path[root_length] == '\0' || path[root_length] == '/');
}

static int unreadable_process_is_inactive_or_outside_fence(
    pid_t process_id,
    uint64_t minimum_start_seconds,
    uint64_t root_process_id) {
  int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, process_id};
  struct kinfo_proc kernel_information = {0};
  size_t kernel_information_size = sizeof(kernel_information);
  if (sysctl(
          mib,
          (u_int)(sizeof(mib) / sizeof(mib[0])),
          &kernel_information,
          &kernel_information_size,
          NULL,
          0) == 0 &&
      kernel_information_size == sizeof(kernel_information) &&
      kernel_information.kp_proc.p_pid == process_id) {
    if (kernel_information.kp_eproc.e_ucred.cr_uid != getuid()) return 1;
    if (kernel_information.kp_proc.p_stat == SZOMB) return 1;
    return (uint64_t)process_id != root_process_id &&
        (uint64_t)kernel_information.kp_proc.p_starttime.tv_sec <
            minimum_start_seconds;
  }
  errno = 0;
  if (kill(process_id, 0) == -1 && errno == ESRCH) return 1;
  return 0;
}

static int inventory(void) {
  uint64_t minimum_start_seconds = 0;
  uint64_t root_process_id = 0;
  const char *bundle_root = getenv(OWNER_BUNDLE_ROOT_KEY);
  struct rion_known_process_fence *known_fences = calloc(
      RION_MAXIMUM_KNOWN_PROCESS_FENCES,
      sizeof(struct rion_known_process_fence));
  size_t known_fence_count = 0;
  if (known_fences == NULL) {
    fprintf(stderr, "known process fence allocation failed\n");
    return 4;
  }
  if (parse_positive_integer(
          getenv(OWNER_MINIMUM_START_KEY), &minimum_start_seconds) != 0 ||
      parse_positive_integer(getenv(OWNER_ROOT_PID_KEY), &root_process_id) != 0 ||
      root_process_id > UINT32_MAX || bundle_root == NULL || bundle_root[0] != '/' ||
      parse_known_process_fences(
          getenv(OWNER_KNOWN_FENCES_KEY), known_fences, &known_fence_count) != 0) {
    fprintf(stderr, "process ownership fence unavailable\n");
    free(known_fences);
    return 2;
  }

  int observed_bytes = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
  if (observed_bytes <= 0 ||
      observed_bytes > (1024 * 1024 - 1024) * (int)sizeof(pid_t)) {
    fprintf(stderr, "proc_listpids capacity failed: %d\n", errno);
    free(known_fences);
    return 3;
  }
  int capacity = observed_bytes / (int)sizeof(pid_t) + 1024;
  pid_t *process_ids = calloc((size_t)capacity, sizeof(pid_t));
  if (process_ids == NULL) {
    fprintf(stderr, "process inventory allocation failed\n");
    free(known_fences);
    return 4;
  }
  int byte_count = proc_listpids(
      PROC_UID_ONLY,
      getuid(),
      process_ids,
      capacity * (int)sizeof(pid_t));
  if (byte_count <= 0 || byte_count >= capacity * (int)sizeof(pid_t) ||
      byte_count % (int)sizeof(pid_t) != 0) {
    fprintf(stderr, "proc_listpids read failed: %d\n", errno);
    free(process_ids);
    free(known_fences);
    return 5;
  }
  int count = byte_count / (int)sizeof(pid_t);

  for (int index = 0; index < count; index += 1) {
    pid_t process_id = process_ids[index];
    if (process_id <= 1 || process_id == getpid()) continue;

    struct rion_proc_bsdinfowithuniqid information = {0};
    if (read_process_identity(process_id, &information) != 0) {
      char fallback_path[PROC_PIDPATHINFO_MAXSIZE] = {0};
      int fallback_path_length = proc_pidpath(
          process_id,
          fallback_path,
          (uint32_t)sizeof(fallback_path));
      if (fallback_path_length < 0 ||
          fallback_path_length >= (int)sizeof(fallback_path)) {
        fallback_path[0] = '\0';
      }
      struct proc_bsdinfo fallback = {0};
      int fallback_bytes = proc_pidinfo(
          process_id,
          PROC_PIDTBSDINFO,
          0,
          &fallback,
          (int)sizeof(fallback));
      int fallback_is_exact = fallback_bytes == (int)sizeof(fallback) &&
          fallback.pbi_pid == (uint32_t)process_id &&
          fallback.pbi_uid == getuid();
      int unreadable_is_inactive = !fallback_is_exact &&
          unreadable_process_is_inactive_or_outside_fence(
              process_id,
              minimum_start_seconds,
              root_process_id);
      int known_exact_process = fallback_is_exact &&
          process_matches_known_fence(
              fallback.pbi_pid,
              fallback.pbi_start_tvsec,
              fallback.pbi_start_tvusec,
              known_fences,
              known_fence_count);
      int known_parent = fallback_is_exact && process_id_is_known(
          fallback.pbi_ppid,
          known_fences,
          known_fence_count);
      int potentially_owned = (uint64_t)process_id == root_process_id ||
          process_id_is_known(
              (uint32_t)process_id, known_fences, known_fence_count) ||
          known_exact_process || known_parent ||
          (fallback_is_exact &&
           (fallback.pbi_ppid == (uint32_t)root_process_id ||
            fallback.pbi_pgid == (uint32_t)root_process_id)) ||
          path_is_inside_bundle(fallback_path, bundle_root);
      if (potentially_owned && !unreadable_is_inactive) {
        fprintf(stderr, "owned process identity was unreadable: %d\n", process_id);
        free(process_ids);
        free(known_fences);
        return 6;
      }
      continue;
    }
    if ((uint64_t)process_id != root_process_id &&
        information.bsd.pbi_start_tvsec < minimum_start_seconds) {
      continue;
    }

    audit_token_t audit_token = audit_token_for_identity(
        information.bsd.pbi_pid,
        information.unique.id_version);
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int path_length = proc_pidpath_audittoken(
        &audit_token,
        path,
        (uint32_t)sizeof(path));
    if (path_length < 0 || path_length >= (int)sizeof(path)) path_length = 0;
    printf(
        "%u\t%u\t%u\t%u\t%llu\t%llu\t%llu\t%llu\t",
        information.bsd.pbi_pid,
        information.bsd.pbi_ppid,
        information.bsd.pbi_pgid,
        information.bsd.pbi_uid,
        information.bsd.pbi_start_tvsec,
        information.bsd.pbi_start_tvusec,
        information.unique.unique_id,
        information.unique.parent_unique_id);
    write_hex((const unsigned char *)&audit_token, sizeof(audit_token));
    putchar('\t');
    if (path_length > 0) {
      write_hex((const unsigned char *)path, (size_t)path_length);
    } else {
      putchar('-');
    }
    putchar('\n');
  }

  free(process_ids);
  free(known_fences);
  if (fflush(stdout) != 0 || ferror(stdout)) {
    fprintf(stderr, "process inventory output failed\n");
    return 7;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 4 && strcmp(argv[1], "--signal") == 0) {
    return signal_audit_token(argv[2], argv[3]);
  }
  if (argc != 1) {
    fprintf(stderr, "invalid process inventory invocation\n");
    return 1;
  }
  return inventory();
}

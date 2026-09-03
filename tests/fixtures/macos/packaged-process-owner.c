#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

static int run_helper(void) {
  if (setsid() < 0) return 21;
  if (signal(SIGTERM, SIG_IGN) == SIG_ERR) return 22;
  if (signal(SIGHUP, SIG_IGN) == SIG_ERR) return 23;
  close(STDIN_FILENO);
  close(STDOUT_FILENO);
  close(STDERR_FILENO);
  for (;;) pause();
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--helper") == 0) {
    return run_helper();
  }
  if (argc != 2) {
    fprintf(stderr, "usage: packaged-process-owner <helper-path>\n");
    return 2;
  }
  if (signal(SIGTERM, SIG_IGN) == SIG_ERR) return 3;

  pid_t helper = fork();
  if (helper < 0) return 4;
  if (helper == 0) {
    execl(argv[1], argv[1], "--helper", (char *)NULL);
    _exit(5);
  }

  for (int attempt = 0; attempt < 200; attempt += 1) {
    pid_t group = getpgid(helper);
    if (group == helper) {
      printf("ready %d\n", helper);
      if (fflush(stdout) != 0) return 6;
      for (;;) pause();
    }
    if (group < 0 && errno == ESRCH) return 7;
    usleep(10 * 1000);
  }
  return 8;
}

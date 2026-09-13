#define _DARWIN_C_SOURCE
#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Loaded only into an isolated test child through DYLD_INSERT_LIBRARIES. The
// production personal addon stays unchanged and contains no test pause hooks.
static int write_external(int parent, const char *name, const char *bytes) {
  int fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0) return -1;
  size_t length = strlen(bytes);
  int result = write(fd, bytes, length) == (ssize_t)length && fsync(fd) == 0 ? 0 : -1;
  close(fd); return result;
}

static int ingestion_race_rename(int from, const char *source, int to, const char *target, unsigned flags) {
  const char *mode = getenv("INGESTION_CONTRACT_RACE");
  if (!mode || !strstr(source, ".stage.md")) return renameatx_np(from, source, to, target, flags);
  if (!strcmp(mode, "replace-before")) {
    if (renameat(to, target, to, "external-held.md") || write_external(to, target, "external-before")) _exit(71);
  } else if (!strcmp(mode, "create-before")) {
    if (write_external(to, target, "external-create")) _exit(72);
  }
  int result = renameatx_np(from, source, to, target, flags); int saved = errno;
  if (!result && !strcmp(mode, "replace-after")) {
    if (renameat(to, target, to, "external-held.md") || write_external(to, target, "external-after")) _exit(73);
  }
  errno = saved; return result;
}

__attribute__((used)) static struct {
  const void *replacement;
  const void *original;
} ingestion_interpose __attribute__((section("__DATA,__interpose"))) = {
  (const void *)&ingestion_race_rename, (const void *)&renameatx_np
};

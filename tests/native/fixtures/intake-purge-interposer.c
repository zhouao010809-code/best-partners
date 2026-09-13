#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Test-child-only interception; production addon contains no hooks.
static int intake_purge_unlink(int parent, const char *name, int flags) {
  const char *root = getenv("INTAKE_PURGE_TEST_ROOT"), *mode = getenv("INTAKE_PURGE_TEST_MODE");
  char directory[PATH_MAX], full[PATH_MAX]; static unsigned calls = 0;
  if (!root || !mode || fcntl(parent, F_GETPATH, directory) < 0) return unlinkat(parent, name, flags);
  int size = snprintf(full, sizeof(full), "%s/%s", directory, name);
  if (size < 0 || (size_t)size >= sizeof(full) || strncmp(full, root, strlen(root)) || !strstr(full, ".packet")) return unlinkat(parent, name, flags);
  if (++calls == 2 && !strcmp(mode, "fail-second")) { errno = EIO; return -1; }
  int result = unlinkat(parent, name, flags), saved = errno;
  if (!result && calls == 1 && !strcmp(mode, "exit-first")) { fsync(parent); _exit(86); }
  errno = saved; return result;
}

__attribute__((used)) static struct { const void *replacement; const void *original; }
  intake_purge_interpose __attribute__((section("__DATA,__interpose"))) = {
    (const void *)&intake_purge_unlink, (const void *)&unlinkat
  };

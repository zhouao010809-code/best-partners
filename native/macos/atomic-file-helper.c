#define _DARWIN_C_SOURCE
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_FILE_BYTES (10U * 1024U * 1024U)
#define MAX_LIST_BYTES (12U * 1024U * 1024U)
#define MAX_ENTRIES 20000U
#define MAX_PATH_BYTES 4096U

static void write_all(const void *data, size_t length) {
  const unsigned char *cursor = data;
  while (length > 0) {
    ssize_t count = write(STDOUT_FILENO, cursor, length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) _exit(1);
    cursor += count;
    length -= (size_t)count;
  }
}

static void frame(const char *header, const void *payload, size_t length) {
  size_t header_length = strlen(header);
  if (header_length == 0 || header_length > 65536U) _exit(1);
  unsigned char prefix[4] = {(unsigned char)(header_length >> 24), (unsigned char)(header_length >> 16),
    (unsigned char)(header_length >> 8), (unsigned char)header_length};
  write_all(prefix, sizeof(prefix));
  write_all(header, header_length);
  write_all(payload, length);
}

static _Noreturn void fail(const char *code) {
  char header[160];
  (void)snprintf(header, sizeof(header), "{\"v\":1,\"ok\":false,\"error\":\"%s\",\"payloadLength\":0}", code);
  frame(header, NULL, 0);
  exit(0);
}

static _Noreturn void fail_open(void) {
  if (errno == ENOENT) fail("NOT_FOUND");
  if (errno == ELOOP || errno == ENOTDIR || errno == EACCES) fail("PATH_NOT_ALLOWED");
  fail("READ_FAILED");
}

static void success(const char *command, const struct stat *root, const char *kind,
                    const void *payload, size_t length) {
  char header[384];
  if (kind != NULL) {
    (void)snprintf(header, sizeof(header),
      "{\"v\":1,\"ok\":true,\"command\":\"%s\",\"root\":{\"dev\":\"%ju\",\"ino\":\"%ju\"},\"payloadLength\":%zu,\"kind\":\"%s\"}",
      command, (uintmax_t)root->st_dev, (uintmax_t)root->st_ino, length, kind);
  } else {
    (void)snprintf(header, sizeof(header),
      "{\"v\":1,\"ok\":true,\"command\":\"%s\",\"root\":{\"dev\":\"%ju\",\"ino\":\"%ju\"},\"payloadLength\":%zu}",
      command, (uintmax_t)root->st_dev, (uintmax_t)root->st_ino, length);
  }
  frame(header, payload, length);
}

static bool valid_utf8(const unsigned char *s) {
  while (*s != 0) {
    uint32_t point;
    size_t tail;
    if (*s < 0x80) { s++; continue; }
    if (*s >= 0xc2 && *s <= 0xdf) { point = *s & 0x1f; tail = 1; }
    else if (*s >= 0xe0 && *s <= 0xef) { point = *s & 0x0f; tail = 2; }
    else if (*s >= 0xf0 && *s <= 0xf4) { point = *s & 0x07; tail = 3; }
    else return false;
    s++;
    for (size_t i = 0; i < tail; i++) {
      if (*s < 0x80 || *s > 0xbf) return false;
      point = (point << 6) | (*s++ & 0x3f);
    }
    if ((tail == 1 && point < 0x80) || (tail == 2 && point < 0x800)
      || (tail == 3 && point < 0x10000) || point > 0x10ffff
      || (point >= 0xd800 && point <= 0xdfff)) return false;
  }
  return true;
}

static void validate_components(const char *path, bool absolute) {
  const size_t length = strlen(path);
  if (length == 0 || length > MAX_PATH_BYTES || (absolute && path[0] != '/')
    || (!absolute && path[0] == '/') || strchr(path, '\\') != NULL
    || !valid_utf8((const unsigned char *)path)) fail("PATH_NOT_ALLOWED");
  const char *start = path + (absolute ? 1 : 0);
  for (;;) {
    const char *separator = strchr(start, '/');
    size_t size = separator == NULL ? strlen(start) : (size_t)(separator - start);
    if (size == 0 || size > 255 || (size == 1 && start[0] == '.')
      || (size == 2 && start[0] == '.' && start[1] == '.')
      || (!absolute && start[0] == '.')) fail("PATH_NOT_ALLOWED");
    if (separator == NULL) break;
    start = separator + 1;
  }
}

static void validate_relative(const char *path, const char *command) {
  validate_components(path, false);
  const char *slash = strchr(path, '/');
  size_t root_length = slash == NULL ? strlen(path) : (size_t)(slash - path);
  const char *roots[] = {"00大脑规则", "01图书馆", "02知识库"};
  bool allowed = false;
  for (size_t i = 0; i < sizeof(roots) / sizeof(roots[0]); i++) {
    if (root_length == strlen(roots[i]) && memcmp(path, roots[i], root_length) == 0) allowed = true;
  }
  if (strcmp(command, "stat-file") == 0 && strcmp(path, "03大讲堂") == 0) allowed = true;
  if (!allowed || (strcmp(command, "read-file") == 0 && slash == NULL)) fail("PATH_NOT_ALLOWED");
}

static uintmax_t parse_identity(const char *value) {
  size_t length = strlen(value);
  if (length == 0 || length > 20 || (length > 1 && value[0] == '0')) fail("INVALID_ARGUMENT");
  for (size_t i = 0; i < length; i++) if (value[i] < '0' || value[i] > '9') fail("INVALID_ARGUMENT");
  errno = 0;
  uintmax_t result = strtoumax(value, NULL, 10);
  if (errno != 0) fail("INVALID_ARGUMENT");
  return result;
}

static int open_root(const char *absolute) {
  validate_components(absolute, true);
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail_open();
  char *copy = strdup(absolute + 1);
  if (copy == NULL) fail("READ_FAILED");
  char *state = NULL;
  for (char *part = strtok_r(copy, "/", &state); part != NULL; part = strtok_r(NULL, "/", &state)) {
    int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) fail_open();
    close(fd);
    fd = next;
  }
  free(copy);
  return fd;
}

static void assert_device(int fd, dev_t device) {
  struct stat metadata;
  if (fstat(fd, &metadata) < 0) fail("READ_FAILED");
  if (metadata.st_dev != device) fail("PATH_NOT_ALLOWED");
}

static int open_parent(int root_fd, char *relative, dev_t device, char **final_name) {
  int fd = dup(root_fd);
  if (fd < 0) fail("READ_FAILED");
  (void)fcntl(fd, F_SETFD, FD_CLOEXEC);
  char *part = relative;
  char *slash;
  while ((slash = strchr(part, '/')) != NULL) {
    *slash = '\0';
    int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) fail_open();
    assert_device(next, device);
    close(fd);
    fd = next;
    part = slash + 1;
  }
  *final_name = part;
  return fd;
}

static void test_pause(const char *stage) {
#ifdef NATIVE_READ_TEST_HOOKS
  const char *requested = getenv("NATIVE_READ_TEST_PAUSE");
  if (requested != NULL && strcmp(requested, stage) == 0) {
    (void)fprintf(stderr, "PAUSED:%s\n", stage);
    (void)fflush(stderr);
    char resume;
    ssize_t count;
    do { count = read(STDIN_FILENO, &resume, 1); } while (count < 0 && errno == EINTR);
    if (count != 1) fail("READ_FAILED");
  }
#else
  (void)stage;
#endif
}

static bool unchanged(const struct stat *before, const struct stat *after) {
  return before->st_dev == after->st_dev && before->st_ino == after->st_ino
    && before->st_size == after->st_size && before->st_mtimespec.tv_sec == after->st_mtimespec.tv_sec
    && before->st_mtimespec.tv_nsec == after->st_mtimespec.tv_nsec;
}

struct entry { char *name; bool directory; };
static int compare_entries(const void *left, const void *right) {
  return strcmp(((const struct entry *)left)->name, ((const struct entry *)right)->name);
}

static void list_directory(int fd, const struct stat *root) {
  struct stat before, after;
  if (fstat(fd, &before) < 0) fail("READ_FAILED");
  DIR *directory = fdopendir(fd);
  if (directory == NULL) fail("TYPE_MISMATCH");
  struct entry *entries = calloc(MAX_ENTRIES, sizeof(*entries));
  if (entries == NULL) fail("READ_FAILED");
  size_t count = 0;
  for (;;) {
    errno = 0;
    struct dirent *current = readdir(directory);
    if (current == NULL) { if (errno != 0) fail("READ_FAILED"); break; }
    const char *name = current->d_name;
    if (name[0] == '.') continue;
    if (strlen(name) == 0 || strlen(name) > 255 || strchr(name, '/') != NULL
      || strchr(name, '\\') != NULL || !valid_utf8((const unsigned char *)name)) fail("PATH_NOT_ALLOWED");
    if (count == MAX_ENTRIES) fail("DIRECTORY_TOO_LARGE");
    struct stat metadata;
    if (fstatat(dirfd(directory), name, &metadata, AT_SYMLINK_NOFOLLOW) < 0) fail("VERSION_CONFLICT");
    if (metadata.st_dev != root->st_dev || (!S_ISREG(metadata.st_mode) && !S_ISDIR(metadata.st_mode))) fail("PATH_NOT_ALLOWED");
    entries[count].name = strdup(name);
    if (entries[count].name == NULL) fail("READ_FAILED");
    entries[count++].directory = S_ISDIR(metadata.st_mode);
  }
  if (fstat(dirfd(directory), &after) < 0) fail("READ_FAILED");
  if (!unchanged(&before, &after)) fail("VERSION_CONFLICT");
  (void)closedir(directory);
  qsort(entries, count, sizeof(*entries), compare_entries);
  char *payload = malloc(MAX_LIST_BYTES);
  if (payload == NULL) fail("READ_FAILED");
  size_t used = 0;
  payload[used++] = '[';
  const char *hex = "0123456789abcdef";
  for (size_t i = 0; i < count; i++) {
    if (i > 0 && strcmp(entries[i - 1].name, entries[i].name) == 0) fail("VERSION_CONFLICT");
    if (used + 600 >= MAX_LIST_BYTES) fail("DIRECTORY_TOO_LARGE");
    if (i > 0) payload[used++] = ',';
    const char *prefix = "{\"nameHex\":\"";
    memcpy(payload + used, prefix, strlen(prefix)); used += strlen(prefix);
    for (const unsigned char *byte = (const unsigned char *)entries[i].name; *byte != 0; byte++) {
      payload[used++] = hex[*byte >> 4]; payload[used++] = hex[*byte & 15];
    }
    int written = snprintf(payload + used, MAX_LIST_BYTES - used, "\",\"kind\":\"%s\"}", entries[i].directory ? "directory" : "file");
    if (written < 0 || (size_t)written >= MAX_LIST_BYTES - used) fail("DIRECTORY_TOO_LARGE");
    used += (size_t)written;
  }
  payload[used++] = ']';
  success("list-dir", root, NULL, payload, used);
  for (size_t i = 0; i < count; i++) free(entries[i].name);
  free(entries); free(payload);
}

static void file_command(int fd, const char *command, const struct stat *root) {
  struct stat before, after;
  if (fstat(fd, &before) < 0) fail("READ_FAILED");
  if (before.st_dev != root->st_dev) fail("PATH_NOT_ALLOWED");
  if (strcmp(command, "stat-file") == 0 && S_ISDIR(before.st_mode)) {
    success(command, root, "directory", NULL, 0); return;
  }
  if (!S_ISREG(before.st_mode)) fail("TYPE_MISMATCH");
  if (before.st_size < 0 || (uintmax_t)before.st_size > MAX_FILE_BYTES) fail("FILE_TOO_LARGE");
  if (strcmp(command, "stat-file") == 0) { success(command, root, "file", NULL, 0); return; }
  size_t size = (size_t)before.st_size;
  unsigned char *payload = malloc(size == 0 ? 1 : size);
  if (payload == NULL) fail("READ_FAILED");
  size_t used = 0;
  while (used < size) {
    ssize_t count = read(fd, payload + used, size - used);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) fail("READ_FAILED");
    if (count == 0) fail("VERSION_CONFLICT");
    used += (size_t)count;
  }
  test_pause("after-read");
  if (fstat(fd, &after) < 0) fail("READ_FAILED");
  if (!unchanged(&before, &after)) fail("VERSION_CONFLICT");
  success(command, root, NULL, payload, size);
  free(payload);
}

int main(int argc, char **argv) {
  if (argc < 3) fail("INVALID_ARGUMENT");
  const char *command = argv[1];
  bool probe = strcmp(command, "probe-root") == 0;
  bool list = strcmp(command, "list-dir") == 0;
  if ((!probe && !list && strcmp(command, "read-file") != 0 && strcmp(command, "stat-file") != 0)
    || argc != (probe ? 3 : 6)) fail("INVALID_ARGUMENT");
  uintmax_t device = 0, inode = 0;
  if (!probe) {
    device = parse_identity(argv[3]); inode = parse_identity(argv[4]);
    validate_relative(argv[5], command);
  }
  int root_fd = open_root(argv[2]);
  struct stat root;
  if (fstat(root_fd, &root) < 0) fail("READ_FAILED");
  test_pause("root");
  if (probe) { success(command, &root, NULL, NULL, 0); close(root_fd); return 0; }
  if ((uintmax_t)root.st_dev != device || (uintmax_t)root.st_ino != inode) fail("ROOT_IDENTITY_CHANGED");
  char *relative = strdup(argv[5]);
  if (relative == NULL) fail("READ_FAILED");
  char *name;
  int parent_fd = open_parent(root_fd, relative, root.st_dev, &name);
  if (!list) test_pause("parent");
  int fd = openat(parent_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (list ? O_DIRECTORY : 0));
  if (fd < 0) fail_open();
  assert_device(fd, root.st_dev);
  close(parent_fd); free(relative);
  if (list) { test_pause("parent"); list_directory(fd, &root); }
  else { file_command(fd, command, &root); close(fd); }
  close(root_fd);
  return 0;
}

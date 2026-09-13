#define _DARWIN_C_SOURCE
#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if defined(PERSONAL_ARCHIVE) && defined(SANDBOX_ARCHIVE_TEST_HOOKS)
#error Personal archive builds cannot contain test hooks.
#endif

#define MAX_PACKAGE_DEPTH 64
#define MAX_PATH_PARTS (MAX_PACKAGE_DEPTH + 4)
#define MAX_ENTRIES 20000
#define MAX_FILE_BYTES (10U * 1024U * 1024U)
#define MAX_RECOVERY_BYTES (32U * 1024U * 1024U)
#define MARKER ".xiaozhao-archive-test.json"
#define RECOVERY ".archive-recovery"
static const char marker_bytes[] = "{\"purpose\":\"archive-test-v1\"}\n";
static const napi_type_tag handle_tag = { UINT64_C(0x7969616f7a68616f), UINT64_C(0x6172636869766531) };
static const napi_type_tag ingestion_tag = { UINT64_C(0x7969616f7a68616f), UINT64_C(0x696e676573743031) };
static const napi_type_tag trash_tag = { UINT64_C(0x7969616f7a68616f), UINT64_C(0x7472617368303031) };
static const napi_type_tag intake_trash_tag = { UINT64_C(0x7969616f7a68616f), UINT64_C(0x6974726173683031) };
static const char *core_directories[] = { "00大脑规则", "01图书馆", "02知识库", "03大讲堂" };

static void test_pause(const char *stage) {
#ifdef SANDBOX_ARCHIVE_TEST_HOOKS
  const char *requested = getenv("SANDBOX_ARCHIVE_TEST_PAUSE");
  if (requested && !strcmp(requested, stage)) {
    fprintf(stderr, "PAUSED:%s\n", stage); fflush(stderr);
    char token;
    while (read(STDIN_FILENO, &token, 1) < 0 && errno == EINTR) {}
  }
#else
  (void)stage;
#endif
}

typedef struct archive_handle {
  int root_fd;
  int recovery_fd;
  bool personal;
  bool ingestion;
  bool trash;
  bool intake_trash;
  struct archive_handle *owner;
  napi_ref owner_ref;
  char root[PATH_MAX];
  char recovery_root[PATH_MAX];
  struct stat root_stat;
  struct stat recovery_stat;
  struct stat core_stat[4];
  struct stat intake_stat;
} archive_handle;

typedef struct {
  char bytes[PATH_MAX];
  char *part[MAX_PATH_PARTS];
  int count;
} archive_path;

typedef struct {
  int fd[MAX_PATH_PARTS];
  struct stat identity[MAX_PATH_PARTS];
  const archive_path *path;
  int count;
} directory_chain;

static const char *system_error(void) {
  switch (errno) {
    case ENOENT: return "NOT_FOUND";
    case EEXIST: case ENOTEMPTY: return "TARGET_EXISTS";
    case ELOOP: return "PATH_NOT_ALLOWED";
    case ENOTDIR: return "TYPE_MISMATCH";
    case EXDEV: return "CROSS_DEVICE";
    default: return "IO_ERROR";
  }
}

static bool same_identity(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}

static bool same_version(const struct stat *a, const struct stat *b) {
  return same_identity(a, b) && a->st_size == b->st_size && a->st_mode == b->st_mode
    && a->st_nlink == b->st_nlink && a->st_uid == b->st_uid
    && a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec
    && a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}

static bool valid_utf8(const unsigned char *s) {
  while (*s) {
    if (*s < 0x80) { s++; continue; }
    unsigned cp; int extra;
    if (*s >= 0xc2 && *s <= 0xdf) { cp = *s & 0x1f; extra = 1; }
    else if (*s >= 0xe0 && *s <= 0xef) { cp = *s & 0x0f; extra = 2; }
    else if (*s >= 0xf0 && *s <= 0xf4) { cp = *s & 7; extra = 3; }
    else return false;
    s++;
    for (int i = 0; i < extra; i++, s++) {
      if ((*s & 0xc0) != 0x80) return false;
      cp = (cp << 6) | (*s & 0x3f);
    }
    if ((extra == 2 && cp < 0x800) || (extra == 3 && cp < 0x10000)
        || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return false;
  }
  return true;
}

static bool valid_name(const char *name) {
  size_t size = strlen(name);
  return size > 0 && size <= NAME_MAX && strcmp(name, ".") && strcmp(name, "..")
    && !strchr(name, '/') && !strchr(name, '\\') && valid_utf8((const unsigned char *)name);
}

static const char *js_string(napi_env env, napi_value value, char *out, size_t capacity) {
  size_t size;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &size) != napi_ok || size >= PATH_MAX) return "PATH_NOT_ALLOWED";
  char16_t units[PATH_MAX];
  if (napi_get_value_string_utf16(env, value, units, PATH_MAX, &size) != napi_ok) return "PATH_NOT_ALLOWED";
  for (size_t i = 0; i < size; i++) {
    if (!units[i]) return "PATH_NOT_ALLOWED";
    if (units[i] >= 0xd800 && units[i] <= 0xdbff) {
      if (++i >= size || units[i] < 0xdc00 || units[i] > 0xdfff) return "PATH_NOT_ALLOWED";
    } else if (units[i] >= 0xdc00 && units[i] <= 0xdfff) return "PATH_NOT_ALLOWED";
  }
  if (napi_get_value_string_utf8(env, value, NULL, 0, &size) != napi_ok || size >= capacity) return "PATH_NOT_ALLOWED";
  if (napi_get_value_string_utf8(env, value, out, capacity, &size) != napi_ok) return "PATH_NOT_ALLOWED";
  return NULL;
}

static const char *split_path(archive_path *path) {
  path->count = 0;
  char *part = path->bytes;
  while (true) {
    if (path->count >= MAX_PATH_PARTS) return "PATH_NOT_ALLOWED";
    char *slash = strchr(part, '/');
    if (slash) *slash = '\0';
    if (!valid_name(part)) return "PATH_NOT_ALLOWED";
    path->part[path->count++] = part;
    if (!slash) return NULL;
    part = slash + 1;
  }
}

static bool valid_month(const char *month) {
  if (strlen(month) != 7 || month[4] != '-') return false;
  for (int i = 0; i < 7; i++) if (i != 4 && (month[i] < '0' || month[i] > '9')) return false;
  int number = (month[5] - '0') * 10 + month[6] - '0';
  return number >= 1 && number <= 12;
}

static bool valid_platform(const char *part) {
  const char *platforms[] = { "来自B站", "来自YouTube", "来自抖音", "来自小红书", "来自公众号", "来自飞书",
    "来自X推特", "来自Reddit", "来自小宇宙", "来自独立站", "来自个人", "来自其他" };
  for (size_t i = 0; i < sizeof(platforms) / sizeof(platforms[0]); i++) if (!strcmp(part, platforms[i])) return true;
  return false;
}

// Data access can inspect these two parent layouts, but read/list begin at a package.
static const char *data_path(napi_env env, napi_value value, archive_path *path, bool allow_parent) {
  const char *error = js_string(env, value, path->bytes, sizeof(path->bytes));
  if (error || (error = split_path(path))) return error;
  if (path->count < 2 || strcmp(path->part[0], "01图书馆")) return "PATH_NOT_ALLOWED";
  if (!strcmp(path->part[1], "小兆clipper")) return path->count >= (allow_parent ? 2 : 3)
    && path->count <= 3 + MAX_PACKAGE_DEPTH ? NULL : "PATH_NOT_ALLOWED";
  if (path->count < 3 || !valid_platform(path->part[1]) || !valid_month(path->part[2])) return "PATH_NOT_ALLOWED";
  return path->count >= (allow_parent ? 3 : 4) ? NULL : "PATH_NOT_ALLOWED";
}

static const char *move_paths(napi_env env, napi_value source, napi_value target, archive_path *from, archive_path *to) {
  const char *error = data_path(env, source, from, false);
  if (!error) error = data_path(env, target, to, false);
  if (error) return error;
  if (from->count != 3 || strcmp(from->part[1], "小兆clipper") || to->count != 4
      || !valid_platform(to->part[1])) return "PATH_NOT_ALLOWED";
  return NULL;
}

static const char *safe_node(archive_handle *handle, const struct stat *st) {
  if (st->st_dev != handle->root_stat.st_dev) return "CROSS_DEVICE";
  if (!S_ISDIR(st->st_mode) && !S_ISREG(st->st_mode)) return "PATH_NOT_ALLOWED";
  if (S_ISREG(st->st_mode) && st->st_nlink != 1) return "PATH_NOT_ALLOWED";
  return NULL;
}

static bool private_node(const struct stat *st, mode_t mode, bool directory) {
  return (directory ? S_ISDIR(st->st_mode) : S_ISREG(st->st_mode) && st->st_nlink == 1)
    && st->st_uid == getuid() && (st->st_mode & 07777) == mode;
}

static bool stage_name(const char *name) {
#ifdef PERSONAL_ARCHIVE
  return strlen(name) == 45 && !strcmp(name + 36, ".stage.md");
#else
  (void)name; return false;
#endif
}

static bool preserved_stage_node(const struct stat *st) {
  return S_ISREG(st->st_mode) && st->st_nlink == 1 && st->st_uid == getuid()
    && ((st->st_mode & 07777) & ~0644) == 0;
}

static bool recovery_node(const struct stat *st, const char *name) {
  return stage_name(name) ? preserved_stage_node(st) : private_node(st, 0600, false);
}

static size_t recovery_limit(const char *name) {
  return stage_name(name) ? MAX_FILE_BYTES : MAX_RECOVERY_BYTES;
}

static int absolute_directory(const char *absolute) {
  if (absolute[0] != '/' || strlen(absolute) >= PATH_MAX) { errno = EINVAL; return -1; }
  archive_path path = {0};
  memcpy(path.bytes, absolute + 1, strlen(absolute));
  if (split_path(&path)) { errno = ELOOP; return -1; }
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  for (int i = 0; fd >= 0 && i < path.count; i++) {
    int next = openat(fd, path.part[i], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    int saved = errno;
    close(fd); fd = next; errno = saved;
  }
  return fd;
}

static const char *validate_marker(int root_fd, dev_t device) {
  int fd = openat(root_fd, MARKER, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return "PATH_NOT_ALLOWED";
  struct stat before, after, path_stat; char bytes[sizeof(marker_bytes)];
  const char *error = NULL;
  if (fstat(fd, &before) || !private_node(&before, 0600, false) || before.st_dev != device
      || before.st_size != (off_t)(sizeof(marker_bytes) - 1)) error = "PATH_NOT_ALLOWED";
  if (!error) {
    ssize_t read_count = pread(fd, bytes, sizeof(bytes), 0);
    if (read_count != (ssize_t)(sizeof(marker_bytes) - 1) || memcmp(bytes, marker_bytes, sizeof(marker_bytes) - 1)
        || fstat(fd, &after) || !same_version(&before, &after)
        || fstatat(root_fd, MARKER, &path_stat, AT_SYMLINK_NOFOLLOW) || !same_version(&after, &path_stat)) error = "PATH_NOT_ALLOWED";
  }
  close(fd); return error;
}

static const char *check_handle(archive_handle *handle) {
  if (handle->root_fd < 0 || (handle->owner && handle->owner->root_fd < 0)) return "HANDLE_CLOSED";
  struct stat st;
  int root_fd = absolute_directory(handle->root);
  if (root_fd < 0) return "ROOT_IDENTITY_CHANGED";
  bool valid = !fstat(root_fd, &st) && same_identity(&st, &handle->root_stat)
    && (handle->personal ? S_ISDIR(st.st_mode) && st.st_uid == getuid() : private_node(&st, 0700, true));
  close(root_fd);
  if (!valid || fstat(handle->root_fd, &st) || !same_identity(&st, &handle->root_stat)) return "ROOT_IDENTITY_CHANGED";
  if (handle->personal) {
    for (int index = 0; index < 4; index++) {
      if (fstatat(handle->root_fd, core_directories[index], &st, AT_SYMLINK_NOFOLLOW)
          || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || !same_identity(&st, &handle->core_stat[index])) return "PARENT_IDENTITY_CHANGED";
    }
    if (handle->intake_trash) {
      int library = openat(handle->root_fd, "01图书馆", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      bool intake_valid = library >= 0 && !fstat(library, &st) && same_identity(&st, &handle->core_stat[1])
        && !fstatat(library, "小兆clipper", &st, AT_SYMLINK_NOFOLLOW) && S_ISDIR(st.st_mode)
        && same_identity(&st, &handle->intake_stat);
      if (library >= 0) close(library);
      if (!intake_valid) return "PARENT_IDENTITY_CHANGED";
    }
    int recovery_fd = absolute_directory(handle->recovery_root);
    if (recovery_fd < 0) return "RECOVERY_IDENTITY_CHANGED";
    valid = !fstat(recovery_fd, &st) && same_identity(&st, &handle->recovery_stat) && private_node(&st, 0700, true);
    close(recovery_fd);
    if (!valid) return "RECOVERY_IDENTITY_CHANGED";
  } else {
    const char *error = validate_marker(handle->root_fd, handle->root_stat.st_dev);
    if (error) return error;
    if (fstatat(handle->root_fd, RECOVERY, &st, AT_SYMLINK_NOFOLLOW) || !same_identity(&st, &handle->recovery_stat)
        || !private_node(&st, 0700, true)) return "RECOVERY_IDENTITY_CHANGED";
  }
  if (fstat(handle->recovery_fd, &st) || !same_identity(&st, &handle->recovery_stat)
      || !private_node(&st, 0700, true)) return "RECOVERY_IDENTITY_CHANGED";
  return NULL;
}

static void close_chain(directory_chain *chain) {
  for (int i = 0; i < chain->count; i++) close(chain->fd[i]);
  chain->count = 0;
}

static const char *open_chain_at(archive_handle *handle, int base, const archive_path *path, int count, directory_chain *chain) {
  chain->path = path; chain->count = 0;
  int parent = base;
  for (int i = 0; i < count; i++) {
    struct stat entry, opened;
    if (fstatat(parent, path->part[i], &entry, AT_SYMLINK_NOFOLLOW)) return system_error();
    const char *error = safe_node(handle, &entry);
    if (error) return error;
    if (!S_ISDIR(entry.st_mode)) return "TYPE_MISMATCH";
    int fd = openat(parent, path->part[i], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return system_error();
    chain->fd[chain->count] = fd;
    chain->identity[chain->count++] = entry;
    if (fstat(fd, &opened) || !same_identity(&opened, &entry)) return "PARENT_IDENTITY_CHANGED";
    parent = fd;
  }
  return NULL;
}

static const char *open_chain(archive_handle *handle, const archive_path *path, int count, directory_chain *chain) {
  return open_chain_at(handle, handle->root_fd, path, count, chain);
}

static int chain_fd(archive_handle *handle, const directory_chain *chain) {
  return chain->count ? chain->fd[chain->count - 1] : handle->root_fd;
}

static const char *check_chain_at(archive_handle *handle, int base, const directory_chain *chain) {
  const char *error = check_handle(handle);
  if (error) return error;
  int parent = base;
  for (int i = 0; i < chain->count; i++) {
    struct stat st;
    if (fstatat(parent, chain->path->part[i], &st, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(st.st_mode)
        || !same_identity(&st, &chain->identity[i]) || fstat(chain->fd[i], &st)
        || !same_identity(&st, &chain->identity[i])) return "PARENT_IDENTITY_CHANGED";
    parent = chain->fd[i];
  }
  return NULL;
}

static const char *check_chain(archive_handle *handle, const directory_chain *chain) {
  return check_chain_at(handle, handle->root_fd, chain);
}

static napi_value failure(napi_env env, const char *code) {
  napi_throw_error(env, code, code); return NULL;
}

static napi_value undefined(napi_env env) {
  napi_value value; napi_get_undefined(env, &value); return value;
}

static napi_value null_value(napi_env env) {
  napi_value value; napi_get_null(env, &value); return value;
}

static void set_string(napi_env env, napi_value object, const char *key, const char *text) {
  napi_value value; napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, object, key, value);
}

static napi_value identity_value(napi_env env, const struct stat *st, bool include_stat) {
  napi_value object; napi_create_object(env, &object); char buffer[32];
  snprintf(buffer, sizeof(buffer), "%ju", (uintmax_t)st->st_dev); set_string(env, object, "dev", buffer);
  snprintf(buffer, sizeof(buffer), "%ju", (uintmax_t)st->st_ino); set_string(env, object, "ino", buffer);
  if (include_stat) {
    set_string(env, object, "kind", S_ISDIR(st->st_mode) ? "directory" : "file");
    napi_value size; napi_create_double(env, (double)st->st_size, &size); napi_set_named_property(env, object, "size", size);
  }
  return object;
}

static void close_handle(archive_handle *handle) {
  if (handle->recovery_fd >= 0) { close(handle->recovery_fd); handle->recovery_fd = -1; }
  if (handle->root_fd >= 0) {
    // A borrowed descriptor shares its owner's open-file description. LOCK_UN
    // here would release the archive lock even while the owner remains open.
    if (!handle->owner) flock(handle->root_fd, LOCK_UN);
    close(handle->root_fd); handle->root_fd = -1;
  }
}

static void finalize(napi_env env, void *data, void *hint) {
  (void)hint; archive_handle *handle = data; close_handle(handle);
  if (handle->owner_ref) napi_delete_reference(env, handle->owner_ref);
  free(handle);
}

static const char *arguments(napi_env env, napi_callback_info info, size_t count, napi_value *args, archive_handle **handle, bool check) {
  size_t argc = count; void *callback_data = NULL;
  if (napi_get_cb_info(env, info, &argc, args, NULL, &callback_data) != napi_ok || argc != count) return "INVALID_ARGUMENT";
  if (!handle) return NULL;
  napi_valuetype type;
  if (napi_typeof(env, args[0], &type) != napi_ok || type != napi_external) return "INVALID_ARGUMENT";
  bool tagged = false;
  const napi_type_tag *tag = callback_data == (void *)3 ? &intake_trash_tag
    : callback_data == (void *)2 ? &trash_tag : callback_data ? &ingestion_tag : &handle_tag;
  if (napi_check_object_type_tag(env, args[0], tag, &tagged) != napi_ok || !tagged
      || napi_get_value_external(env, args[0], (void **)handle) != napi_ok || !*handle) return "INVALID_ARGUMENT";
  return check ? check_handle(*handle) : NULL;
}

static bool sandbox_root_path(const char *root) {
  if (root[0] != '/' || strchr(root, '\\') || !valid_utf8((const unsigned char *)root)) return false;
  const char *base = strrchr(root, '/');
  if (!base || strncmp(base + 1, "xiaozhao-archive-test-", strlen("xiaozhao-archive-test-")) || !valid_name(base + 1)) return false;
  char parent[PATH_MAX]; size_t length = (size_t)(base - root);
  memcpy(parent, root, length); parent[length] = '\0';
  if (!strcmp(parent, "/private/tmp")) return true;
  char temp[PATH_MAX], canonical[PATH_MAX];
  size_t required = confstr(_CS_DARWIN_USER_TEMP_DIR, temp, sizeof(temp));
  return required > 0 && required <= sizeof(temp) && realpath(temp, canonical) && !strcmp(parent, canonical);
}

static napi_value archive_open(napi_env env, napi_callback_info info) {
  napi_value args[1]; const char *error = arguments(env, info, 1, args, NULL, false);
  if (error) return failure(env, error);
  archive_handle *handle = calloc(1, sizeof(*handle));
  if (!handle) return failure(env, "IO_ERROR");
  handle->root_fd = -1; handle->recovery_fd = -1;
  error = js_string(env, args[0], handle->root, sizeof(handle->root));
  if (!error && !sandbox_root_path(handle->root)) error = "PATH_NOT_ALLOWED";
  if (!error) {
    handle->root_fd = absolute_directory(handle->root);
    if (handle->root_fd < 0 || fstat(handle->root_fd, &handle->root_stat) || !private_node(&handle->root_stat, 0700, true)) error = "PATH_NOT_ALLOWED";
  }
  if (!error) error = validate_marker(handle->root_fd, handle->root_stat.st_dev);
  if (!error && flock(handle->root_fd, LOCK_EX | LOCK_NB)) error = errno == EWOULDBLOCK ? "ROOT_LOCKED" : "IO_ERROR";
  if (!error) {
    handle->recovery_fd = openat(handle->root_fd, RECOVERY, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (handle->recovery_fd < 0 || fstat(handle->recovery_fd, &handle->recovery_stat)
        || handle->recovery_stat.st_dev != handle->root_stat.st_dev || !private_node(&handle->recovery_stat, 0700, true)) error = "PATH_NOT_ALLOWED";
  }
  if (!error) error = check_handle(handle);
  if (error) { close_handle(handle); free(handle); return failure(env, error); }
  napi_value external;
  if (napi_create_external(env, handle, finalize, NULL, &external) != napi_ok) { close_handle(handle); free(handle); return failure(env, "IO_ERROR"); }
  if (napi_type_tag_object(env, external, &handle_tag) != napi_ok) { close_handle(handle); return failure(env, "IO_ERROR"); }
  return external;
}

static napi_value archive_close(napi_env env, napi_callback_info info) {
  napi_value args[1]; archive_handle *handle; const char *error = arguments(env, info, 1, args, &handle, false);
  if (error) return failure(env, error);
  close_handle(handle); return undefined(env);
}

static napi_value archive_root_identity(napi_env env, napi_callback_info info) {
  napi_value args[1]; archive_handle *handle; const char *error = arguments(env, info, 1, args, &handle, true);
  return error ? failure(env, error) : identity_value(env, &handle->root_stat, false);
}

static napi_value archive_stat(napi_env env, napi_callback_info info) {
  napi_value args[2]; archive_handle *handle; archive_path path; directory_chain chain = {0}; struct stat st;
  const char *error = arguments(env, info, 2, args, &handle, true);
  if (!error) error = data_path(env, args[1], &path, true);
  if (!error) error = open_chain(handle, &path, path.count - 1, &chain);
  bool missing = false;
  if (!error && fstatat(chain_fd(handle, &chain), path.part[path.count - 1], &st, AT_SYMLINK_NOFOLLOW)) {
    if (errno == ENOENT) missing = true; else error = system_error();
  }
  if (!error && !missing) error = safe_node(handle, &st);
  if (!error) error = check_chain(handle, &chain);
  close_chain(&chain);
  return error ? failure(env, error) : missing ? null_value(env) : identity_value(env, &st, true);
}

static const char *read_bytes(archive_handle *handle, int parent, const char *name, size_t limit, int file_policy, unsigned char **output, size_t *length) {
  struct stat entry, before, after, current;
  if (fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW)) return system_error();
  const char *error = safe_node(handle, &entry);
  if (error) return error;
  if (!S_ISREG(entry.st_mode)) return "TYPE_MISMATCH";
  if ((file_policy == 1 && !private_node(&entry, 0600, false))
      || (file_policy == 2 && !preserved_stage_node(&entry))) return "PATH_NOT_ALLOWED";
  if (entry.st_size < 0 || (uintmax_t)entry.st_size > limit) return "FILE_TOO_LARGE";
  int fd = openat(parent, name, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return system_error();
  if (fstat(fd, &before) || !same_version(&entry, &before)) error = "VERSION_CONFLICT";
  unsigned char *bytes = NULL;
  if (!error) { bytes = malloc((size_t)before.st_size + 1); if (!bytes) error = "IO_ERROR"; }
  size_t offset = 0;
  while (!error && offset < (size_t)before.st_size) {
    ssize_t count = pread(fd, bytes + offset, (size_t)before.st_size - offset, (off_t)offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { error = "VERSION_CONFLICT"; break; }
    offset += (size_t)count;
  }
  if (!error && (fstat(fd, &after) || !same_version(&before, &after)
      || fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) || !same_version(&after, &current))) error = "VERSION_CONFLICT";
  close(fd);
  if (error) { free(bytes); return error; }
  *output = bytes; *length = offset; return NULL;
}

static napi_value buffer_value(napi_env env, unsigned char *bytes, size_t length) {
  napi_value buffer; napi_status status = napi_create_buffer_copy(env, length, bytes, NULL, &buffer); free(bytes);
  return status == napi_ok ? buffer : failure(env, "IO_ERROR");
}

static napi_value archive_read(napi_env env, napi_callback_info info) {
  napi_value args[2]; archive_handle *handle; archive_path path; directory_chain chain = {0};
  unsigned char *bytes = NULL; size_t length = 0;
  const char *error = arguments(env, info, 2, args, &handle, true);
  if (!error) error = data_path(env, args[1], &path, false);
  if (!error) error = open_chain(handle, &path, path.count - 1, &chain);
  if (!error) error = read_bytes(handle, chain_fd(handle, &chain), path.part[path.count - 1], MAX_FILE_BYTES, false, &bytes, &length);
  if (!error) error = check_chain(handle, &chain);
  close_chain(&chain);
  if (error) { free(bytes); return failure(env, error); }
  return buffer_value(env, bytes, length);
}

static bool recovery_name(const char *name) {
  size_t length = strlen(name);
  if (!stage_name(name) && (length != 48 || (strcmp(name + 36, ".intent.json") && strcmp(name + 36, ".result.json")))) return false;
  for (int i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (name[i] != '-') return false; }
    else if (!((name[i] >= '0' && name[i] <= '9') || (name[i] >= 'a' && name[i] <= 'f'))) return false;
  }
  return name[14] == '4' && strchr("89ab", name[19]);
}

static const char *recovery_argument(napi_env env, napi_value value, char *name) {
  const char *error = js_string(env, value, name, 64);
  return error ? error : recovery_name(name) ? NULL : "PATH_NOT_ALLOWED";
}

static bool trash_recovery_name(const char *name) {
  if (strlen(name) != 48 || (strcmp(name + 36, ".intent.json") && strcmp(name + 36, ".delete.json"))) return false;
  char intent[64]; memcpy(intent, name, 36); strcpy(intent + 36, ".intent.json");
  return recovery_name(intent);
}

static bool intake_trash_recovery_name(const char *name) {
  size_t length = strlen(name);
  if (!((length == 48 && !strcmp(name + 36, ".intent.json"))
      || (length == 48 && !strcmp(name + 36, ".delete.json"))
      || (length == 49 && (!strcmp(name + 36, ".confirm.json") || !strcmp(name + 36, ".deleted.json")))
      || (length == 49 && !strcmp(name + 36, ".restore.json"))
      || (length == 50 && !strcmp(name + 36, ".restored.json")))) return false;
  char intent[64]; memcpy(intent, name, 36); strcpy(intent + 36, ".intent.json");
  return recovery_name(intent);
}

static const char *journal_argument(napi_env env, napi_value value, archive_handle *handle, char *name) {
  if (!handle->intake_trash && !handle->trash) return recovery_argument(env, value, name);
  const char *error = js_string(env, value, name, 64);
  if (error) return error;
  bool valid = handle->intake_trash ? intake_trash_recovery_name(name)
    : handle->trash ? trash_recovery_name(name) : recovery_name(name);
  return valid ? NULL : "PATH_NOT_ALLOWED";
}

static const char *list_directory(napi_env env, archive_handle *handle, int fd, bool recovery, napi_value *result) {
  int copy = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (copy < 0) return system_error();
  DIR *directory = fdopendir(copy);
  if (!directory) { close(copy); return "IO_ERROR"; }
  struct stat before, after;
  const char *error = fstat(fd, &before) ? "IO_ERROR" : NULL;
  if (!error && napi_create_array(env, result) != napi_ok) error = "IO_ERROR";
  unsigned count = 0;
  while (!error) {
    errno = 0; struct dirent *entry = readdir(directory);
    if (!entry) { if (errno) error = "IO_ERROR"; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++count > MAX_ENTRIES) { error = "DIRECTORY_TOO_LARGE"; break; }
    if (!valid_name(entry->d_name) || (recovery && !recovery_name(entry->d_name))) { error = "PATH_NOT_ALLOWED"; break; }
    struct stat st;
    if (fstatat(fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW)) { error = system_error(); break; }
    error = safe_node(handle, &st);
    if (!error && recovery && !recovery_node(&st, entry->d_name)) error = "PATH_NOT_ALLOWED";
    if (error) break;
    napi_value value;
    if (recovery) napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &value);
    else { napi_create_object(env, &value); set_string(env, value, "name", entry->d_name); set_string(env, value, "kind", S_ISDIR(st.st_mode) ? "directory" : "file"); }
    if (napi_set_element(env, *result, count - 1, value) != napi_ok) error = "IO_ERROR";
  }
  if (!error && (fstat(fd, &after) || !same_version(&before, &after))) error = "VERSION_CONFLICT";
  closedir(directory); return error;
}

static napi_value archive_list(napi_env env, napi_callback_info info) {
  napi_value args[2], result; archive_handle *handle; archive_path path; directory_chain chain = {0};
  const char *error = arguments(env, info, 2, args, &handle, true);
  if (!error) error = data_path(env, args[1], &path, false);
  if (!error) error = open_chain(handle, &path, path.count, &chain);
  if (!error) error = list_directory(env, handle, chain_fd(handle, &chain), false, &result);
  if (!error) error = check_chain(handle, &chain);
  close_chain(&chain); return error ? failure(env, error) : result;
}

static const char *validate_tree(archive_handle *handle, int fd, int depth, size_t relative_length,
    size_t source_length, size_t target_length, size_t *count) {
  if (depth > MAX_PACKAGE_DEPTH) return "PATH_NOT_ALLOWED";
  int copy = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (copy < 0) return system_error();
  DIR *directory = fdopendir(copy);
  if (!directory) { close(copy); return "IO_ERROR"; }
  struct stat before, after;
  const char *error = fstat(fd, &before) ? "IO_ERROR" : NULL;
  while (!error) {
    errno = 0; struct dirent *entry = readdir(directory);
    if (!entry) { if (errno) error = "IO_ERROR"; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++*count > MAX_ENTRIES) { error = "DIRECTORY_TOO_LARGE"; break; }
    if (!valid_name(entry->d_name)) { error = "PATH_NOT_ALLOWED"; break; }
    size_t child_length = relative_length + (depth ? 1 : 0) + strlen(entry->d_name);
    if (depth + 1 > MAX_PACKAGE_DEPTH || source_length + 1 + child_length >= PATH_MAX
        || target_length + 1 + child_length >= PATH_MAX) { error = "PATH_NOT_ALLOWED"; break; }
    struct stat child, opened, current;
    if (fstatat(fd, entry->d_name, &child, AT_SYMLINK_NOFOLLOW)) { error = system_error(); break; }
    error = safe_node(handle, &child);
    if (!error && S_ISREG(child.st_mode) && (child.st_size < 0 || (uintmax_t)child.st_size > MAX_FILE_BYTES)) error = "FILE_TOO_LARGE";
    if (error) break;
    if (S_ISDIR(child.st_mode)) {
      int child_fd = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      if (child_fd < 0) { error = system_error(); break; }
      if (fstat(child_fd, &opened) || !same_version(&child, &opened)) error = "VERSION_CONFLICT";
      if (!error) error = validate_tree(handle, child_fd, depth + 1, child_length, source_length, target_length, count);
      close(child_fd);
    }
    if (!error && (fstatat(fd, entry->d_name, &current, AT_SYMLINK_NOFOLLOW) || !same_version(&child, &current))) error = "VERSION_CONFLICT";
  }
  if (!error && (fstat(fd, &after) || !same_version(&before, &after))) error = "VERSION_CONFLICT";
  closedir(directory); return error;
}

static size_t path_length(const archive_path *path) {
  size_t length = (size_t)path->count - 1;
  for (int index = 0; index < path->count; index++) length += strlen(path->part[index]);
  return length;
}

static const char *expected_identity(napi_env env, napi_value object, const struct stat *st) {
  napi_valuetype type;
  if (napi_typeof(env, object, &type) != napi_ok || type != napi_object) return "INVALID_ARGUMENT";
  const char *keys[] = { "dev", "ino" }; uintmax_t values[] = { (uintmax_t)st->st_dev, (uintmax_t)st->st_ino };
  for (int i = 0; i < 2; i++) {
    napi_value value; char text[32], expected[32];
    if (napi_get_named_property(env, object, keys[i], &value) != napi_ok || js_string(env, value, text, sizeof(text))) return "INVALID_ARGUMENT";
    snprintf(expected, sizeof(expected), "%ju", values[i]);
    if (strcmp(text, expected)) return "SOURCE_IDENTITY_CHANGED";
  }
  return NULL;
}

static const char *sync_chains(archive_handle *handle, directory_chain *source, directory_chain *target) {
  const char *error = check_chain(handle, source);
  if (!error) error = check_chain(handle, target);
  if (!error && (fsync(chain_fd(handle, source)) || fsync(chain_fd(handle, target)))) error = "IO_ERROR";
  if (!error) error = check_chain(handle, source);
  if (!error) error = check_chain(handle, target);
  return error;
}

static napi_value archive_move(napi_env env, napi_callback_info info) {
  napi_value args[4]; archive_handle *handle; archive_path source, target;
  directory_chain from = {0}, to = {0}; int source_fd = -1; bool moved = false;
  struct stat before, current; size_t count = 0;
  const char *error = arguments(env, info, 4, args, &handle, true);
  if (!error) error = move_paths(env, args[1], args[2], &source, &target);
  if (!error) error = open_chain(handle, &source, source.count - 1, &from);
  if (!error) error = open_chain(handle, &target, target.count - 1, &to);
  int from_fd = -1, to_fd = -1;
  if (!error) {
    from_fd = chain_fd(handle, &from); to_fd = chain_fd(handle, &to);
    if (fstatat(from_fd, source.part[2], &before, AT_SYMLINK_NOFOLLOW)) error = system_error();
  }
  if (!error) error = safe_node(handle, &before);
  if (!error && !S_ISDIR(before.st_mode)) error = "TYPE_MISMATCH";
  if (!error) error = expected_identity(env, args[3], &before);
  if (!error) {
    source_fd = openat(from_fd, source.part[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (source_fd < 0) error = system_error();
    else if (fstat(source_fd, &current) || !same_identity(&before, &current)) error = "SOURCE_IDENTITY_CHANGED";
  }
  if (!error) error = validate_tree(handle, source_fd, 0, 0, path_length(&source), path_length(&target), &count);
  if (!error) error = check_chain(handle, &from);
  if (!error) error = check_chain(handle, &to);
  if (!error && (fstatat(from_fd, source.part[2], &current, AT_SYMLINK_NOFOLLOW) || !same_identity(&before, &current))) error = "SOURCE_IDENTITY_CHANGED";
  // macOS rename has no source-inode CAS. A swap after this check is detected
  // below and preserved for review; it cannot be silently described as success.
  if (!error) {
    test_pause("before-rename");
    if (renameatx_np(from_fd, source.part[2], to_fd, target.part[3], RENAME_EXCL | RENAME_NOFOLLOW_ANY)) error = system_error();
    else moved = true;
  }
  if (!error) test_pause("after-rename");
  if (!error) error = check_chain(handle, &from);
  if (!error) error = check_chain(handle, &to);
  if (!error && (fstatat(to_fd, target.part[3], &current, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(current.st_mode) || !same_identity(&before, &current))) error = "SOURCE_IDENTITY_CHANGED";
  if (!error && (fstatat(from_fd, source.part[2], &current, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT)) error = "SOURCE_IDENTITY_CHANGED";
  count = 0;
  if (!error) error = validate_tree(handle, source_fd, 0, 0, path_length(&source), path_length(&target), &count);
  if (!error) error = sync_chains(handle, &from, &to);
  if (!error) test_pause("after-sync");
  if (!error) error = check_chain(handle, &from);
  if (!error) error = check_chain(handle, &to);
  if (!error && (fstatat(to_fd, target.part[3], &current, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(current.st_mode) || !same_identity(&before, &current))) error = "SOURCE_IDENTITY_CHANGED";
  if (!error && (fstatat(from_fd, source.part[2], &current, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT)) error = "SOURCE_IDENTITY_CHANGED";
  if (source_fd >= 0) close(source_fd);
  close_chain(&from); close_chain(&to);
  return error ? failure(env, moved ? "MOVED_NEEDS_REVIEW" : error) : undefined(env);
}

static napi_value archive_sync_parents(napi_env env, napi_callback_info info) {
  napi_value args[3]; archive_handle *handle; archive_path source, target; directory_chain from = {0}, to = {0};
  const char *error = arguments(env, info, 3, args, &handle, true);
  if (!error) error = move_paths(env, args[1], args[2], &source, &target);
  if (!error) error = open_chain(handle, &source, source.count - 1, &from);
  if (!error) error = open_chain(handle, &target, target.count - 1, &to);
  if (!error) error = sync_chains(handle, &from, &to);
  close_chain(&from); close_chain(&to);
  return error ? failure(env, error) : undefined(env);
}

static napi_value archive_read_recovery(napi_env env, napi_callback_info info) {
  napi_value args[2]; archive_handle *handle; char name[64]; unsigned char *bytes = NULL; size_t length = 0;
  const char *error = arguments(env, info, 2, args, &handle, true);
  if (!error) error = journal_argument(env, args[1], handle, name);
  bool missing = false;
  if (!error) {
    error = read_bytes(handle, handle->recovery_fd, name, recovery_limit(name), stage_name(name) ? 2 : 1, &bytes, &length);
    if (error && !strcmp(error, "NOT_FOUND")) { error = NULL; missing = true; }
  }
  if (!error) error = check_handle(handle);
  if (error) { free(bytes); return failure(env, error); }
  return missing ? null_value(env) : buffer_value(env, bytes, length);
}

static napi_value archive_list_recovery(napi_env env, napi_callback_info info) {
  napi_value args[1], result; archive_handle *handle;
  const char *error = arguments(env, info, 1, args, &handle, true);
  if (!error) error = list_directory(env, handle, handle->recovery_fd, true, &result);
  if (!error) error = check_handle(handle);
  return error ? failure(env, error) : result;
}

static napi_value archive_write_recovery(napi_env env, napi_callback_info info) {
  napi_value args[3]; archive_handle *handle; char name[64]; void *bytes = NULL; size_t length = 0;
  const char *error = arguments(env, info, 3, args, &handle, true);
  if (!error) error = journal_argument(env, args[1], handle, name);
  bool is_buffer = false;
  if (!error && (napi_is_buffer(env, args[2], &is_buffer) != napi_ok || !is_buffer
      || napi_get_buffer_info(env, args[2], &bytes, &length) != napi_ok)) error = "INVALID_ARGUMENT";
  if (!error && length > recovery_limit(name)) error = "FILE_TOO_LARGE";
  int fd = -1; struct stat before, after;
  if (!error) {
    fd = openat(handle->recovery_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0) error = system_error();
    else if (fstat(fd, &before) || !private_node(&before, 0600, false) || before.st_dev != handle->root_stat.st_dev) error = "PATH_NOT_ALLOWED";
  }
  size_t offset = 0;
  while (!error && offset < length) {
    ssize_t count = write(fd, (unsigned char *)bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { error = "IO_ERROR"; break; }
    offset += (size_t)count;
  }
  if (!error && (fsync(fd) || fstat(fd, &after) || !same_identity(&before, &after)
      || !private_node(&after, 0600, false) || after.st_size != (off_t)length)) error = "IO_ERROR";
  if (fd >= 0) close(fd);
  unsigned char *saved = NULL; size_t saved_length = 0;
  if (!error) error = read_bytes(handle, handle->recovery_fd, name, MAX_RECOVERY_BYTES, true, &saved, &saved_length);
  if (!error && (saved_length != length || memcmp(saved, bytes, length))) error = "VERSION_CONFLICT";
  free(saved);
  if (!error && (fstatat(handle->recovery_fd, name, &after, AT_SYMLINK_NOFOLLOW) || !same_identity(&before, &after))) error = "VERSION_CONFLICT";
  if (!error && fsync(handle->recovery_fd)) error = "IO_ERROR";
  if (!error) error = check_handle(handle);
  // A failed or interrupted creation stays in place for inspection. Never
  // unlink, truncate, overwrite, append to, or silently repair a journal file.
  return error ? failure(env, error) : undefined(env);
}

#ifdef PERSONAL_ARCHIVE
static bool nested_root(const char *parent, const char *child) {
  size_t length = strlen(parent);
  return !strncmp(parent, child, length) && (child[length] == '/' || child[length] == '\0');
}

static napi_value archive_open_personal(napi_env env, napi_callback_info info) {
  napi_value args[2]; const char *error = arguments(env, info, 2, args, NULL, false);
  if (error) return failure(env, error);
  archive_handle *handle = calloc(1, sizeof(*handle));
  if (!handle) return failure(env, "IO_ERROR");
  handle->root_fd = -1; handle->recovery_fd = -1; handle->personal = true;
  error = js_string(env, args[0], handle->root, sizeof(handle->root));
  if (!error) error = js_string(env, args[1], handle->recovery_root, sizeof(handle->recovery_root));
  if (!error && (nested_root(handle->root, handle->recovery_root) || nested_root(handle->recovery_root, handle->root))) error = "PATH_NOT_ALLOWED";
  if (!error) {
    handle->root_fd = absolute_directory(handle->root);
    if (handle->root_fd < 0 || fstat(handle->root_fd, &handle->root_stat)
        || !S_ISDIR(handle->root_stat.st_mode) || handle->root_stat.st_uid != getuid()) error = "PATH_NOT_ALLOWED";
  }
  if (!error && flock(handle->root_fd, LOCK_EX | LOCK_NB)) error = errno == EWOULDBLOCK ? "ROOT_LOCKED" : "IO_ERROR";
  for (int index = 0; !error && index < 4; index++) {
    struct stat *st = &handle->core_stat[index];
    if (fstatat(handle->root_fd, core_directories[index], st, AT_SYMLINK_NOFOLLOW)
        || !S_ISDIR(st->st_mode) || st->st_uid != getuid() || st->st_dev != handle->root_stat.st_dev) error = "PATH_NOT_ALLOWED";
  }
  if (!error) {
    handle->recovery_fd = absolute_directory(handle->recovery_root);
    if (handle->recovery_fd < 0 || fstat(handle->recovery_fd, &handle->recovery_stat)
        || !private_node(&handle->recovery_stat, 0700, true)) error = "PATH_NOT_ALLOWED";
    else if (handle->recovery_stat.st_dev != handle->root_stat.st_dev) error = "CROSS_DEVICE";
  }
  if (!error) error = check_handle(handle);
  if (error) { close_handle(handle); free(handle); return failure(env, error); }
  napi_value external;
  if (napi_create_external(env, handle, finalize, NULL, &external) != napi_ok) { close_handle(handle); free(handle); return failure(env, "IO_ERROR"); }
  if (napi_type_tag_object(env, external, &handle_tag) != napi_ok) { close_handle(handle); return failure(env, "IO_ERROR"); }
  return external;
}

static const char *personal_arguments(napi_env env, napi_callback_info info, size_t count, napi_value *args, archive_handle **handle) {
  const char *error = arguments(env, info, count, args, handle, true);
  return error ? error : (*handle)->personal ? NULL : "PATH_NOT_ALLOWED";
}

static napi_value archive_list_intake(napi_env env, napi_callback_info info) {
  napi_value args[1], result; archive_handle *handle; archive_path path = {0}; directory_chain chain = {0};
  const char *error = personal_arguments(env, info, 1, args, &handle);
  if (!error) { strcpy(path.bytes, "01图书馆/小兆clipper"); error = split_path(&path); }
  if (!error) error = open_chain(handle, &path, path.count, &chain);
  if (!error) error = list_directory(env, handle, chain_fd(handle, &chain), false, &result);
  if (!error) error = check_chain(handle, &chain);
  close_chain(&chain); return error ? failure(env, error) : result;
}

static napi_value archive_ensure_month(napi_env env, napi_callback_info info) {
  napi_value args[3]; archive_handle *handle; archive_path path = {0}; directory_chain chain = {0};
  char platform[NAME_MAX + 1], month[16], parent[NAME_MAX + 1];
  const char *error = personal_arguments(env, info, 3, args, &handle);
  if (!error) error = js_string(env, args[1], platform, sizeof(platform));
  if (!error) error = js_string(env, args[2], month, sizeof(month));
  if (!error) {
    int length = snprintf(parent, sizeof(parent), "来自%s", platform);
    if (length < 0 || (size_t)length >= sizeof(parent) || !valid_platform(parent)
        || !valid_month(month) || month[0] == '0') error = "PATH_NOT_ALLOWED";
  }
  if (!error) {
    snprintf(path.bytes, sizeof(path.bytes), "01图书馆/%s", parent);
    error = split_path(&path);
  }
  if (!error) error = open_chain(handle, &path, path.count, &chain);
  if (!error) error = check_chain(handle, &chain);
  int parent_fd = -1, month_fd = -1; struct stat before, current;
  if (!error) {
    parent_fd = chain_fd(handle, &chain);
    if (mkdirat(parent_fd, month, 0700) && errno != EEXIST) error = system_error();
  }
  if (!error) {
    if (fstatat(parent_fd, month, &before, AT_SYMLINK_NOFOLLOW)) error = system_error();
    else if (!S_ISDIR(before.st_mode) || before.st_uid != getuid()) error = "PATH_NOT_ALLOWED";
    else if (before.st_dev != handle->root_stat.st_dev) error = "CROSS_DEVICE";
  }
  if (!error) {
    month_fd = openat(parent_fd, month, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (month_fd < 0) error = system_error();
    else if (fstat(month_fd, &current) || !same_identity(&before, &current)) error = "PARENT_IDENTITY_CHANGED";
  }
  if (!error && (fsync(month_fd) || fsync(parent_fd))) error = "IO_ERROR";
  if (!error) error = check_chain(handle, &chain);
  if (!error && (fstatat(parent_fd, month, &current, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(current.st_mode)
      || !same_identity(&before, &current))) error = "PARENT_IDENTITY_CHANGED";
  if (month_fd >= 0) close(month_fd);
  close_chain(&chain);
  // An empty month created before a failure remains for inspection; never remove it.
  return error ? failure(env, error) : undefined(env);
}

static napi_value archive_stat_recovery(napi_env env, napi_callback_info info) {
  napi_value args[2]; archive_handle *handle; char name[64]; struct stat st; bool missing = false;
  const char *error = personal_arguments(env, info, 2, args, &handle);
  if (!error) error = recovery_argument(env, args[1], name);
  if (!error && fstatat(handle->recovery_fd, name, &st, AT_SYMLINK_NOFOLLOW)) {
    if (errno == ENOENT) missing = true; else error = system_error();
  }
  if (!error && !missing) {
    error = safe_node(handle, &st);
    if (!error && !recovery_node(&st, name)) error = "PATH_NOT_ALLOWED";
    if (!error && (st.st_size < 0 || (uintmax_t)st.st_size > recovery_limit(name))) error = "FILE_TOO_LARGE";
  }
  if (!error) error = check_handle(handle);
  return error ? failure(env, error) : missing ? null_value(env) : identity_value(env, &st, true);
}

static const char *main_path(napi_env env, napi_value value, archive_path *path) {
  const char *error = data_path(env, value, path, false);
  if (error) return error;
  if (path->count != 4 || strcmp(path->part[1], "小兆clipper")) return "PATH_NOT_ALLOWED";
  size_t length = strlen(path->part[3]);
  return length > 3 && !strcmp(path->part[3] + length - 3, ".md") ? NULL : "PATH_NOT_ALLOWED";
}

static const char *check_file_identity(archive_handle *handle, int parent, const char *name, const struct stat *expected) {
  struct stat current;
  if (fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW)) return system_error();
  const char *error = safe_node(handle, &current);
  if (error) return error;
  return S_ISREG(current.st_mode) && same_identity(&current, expected) ? NULL : "SOURCE_IDENTITY_CHANGED";
}

static const char *compare_file_bytes(archive_handle *handle, int parent, const char *name,
    int policy, const unsigned char *expected, size_t expected_length) {
  unsigned char *bytes = NULL; size_t length = 0;
  const char *error = read_bytes(handle, parent, name, MAX_FILE_BYTES, policy, &bytes, &length);
  if (!error && (length != expected_length || memcmp(bytes, expected, length))) error = "VERSION_CONFLICT";
  free(bytes); return error;
}

static napi_value archive_swap_main(napi_env env, napi_callback_info info) {
  napi_value args[5]; archive_handle *handle; archive_path path; directory_chain chain = {0};
  char stage[64]; struct stat main_before, stage_before, current; int parent = -1; bool swapped = false;
  unsigned char *main_bytes = NULL, *stage_bytes = NULL; size_t main_length = 0, stage_length = 0;
  const char *error = personal_arguments(env, info, 5, args, &handle);
  if (!error) error = main_path(env, args[1], &path);
  if (!error) error = recovery_argument(env, args[2], stage);
  if (!error && !stage_name(stage)) error = "PATH_NOT_ALLOWED";
  if (!error) error = open_chain(handle, &path, 3, &chain);
  if (!error) {
    parent = chain_fd(handle, &chain);
    if (fstatat(parent, path.part[3], &main_before, AT_SYMLINK_NOFOLLOW)
        || fstatat(handle->recovery_fd, stage, &stage_before, AT_SYMLINK_NOFOLLOW)) error = system_error();
  }
  if (!error && (!preserved_stage_node(&main_before) || !preserved_stage_node(&stage_before))) error = "PATH_NOT_ALLOWED";
  if (!error) error = safe_node(handle, &main_before);
  if (!error) error = safe_node(handle, &stage_before);
  if (!error) error = expected_identity(env, args[3], &main_before);
  if (!error) error = expected_identity(env, args[4], &stage_before);
  if (!error) error = read_bytes(handle, parent, path.part[3], MAX_FILE_BYTES, 2, &main_bytes, &main_length);
  if (!error) error = read_bytes(handle, handle->recovery_fd, stage, MAX_FILE_BYTES, 2, &stage_bytes, &stage_length);
  if (!error) error = check_chain(handle, &chain);
  if (!error && (fstatat(parent, path.part[3], &current, AT_SYMLINK_NOFOLLOW) || !same_version(&main_before, &current)
      || fstatat(handle->recovery_fd, stage, &current, AT_SYMLINK_NOFOLLOW) || !same_version(&stage_before, &current))) error = "SOURCE_IDENTITY_CHANGED";
  if (!error) {
    if (renameatx_np(parent, path.part[3], handle->recovery_fd, stage, RENAME_SWAP | RENAME_NOFOLLOW_ANY)) error = system_error();
    else swapped = true;
  }
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = check_file_identity(handle, parent, path.part[3], &stage_before);
  if (!error) error = check_file_identity(handle, handle->recovery_fd, stage, &main_before);
  if (!error && (fsync(parent) || fsync(handle->recovery_fd))) error = "IO_ERROR";
  if (!error) error = compare_file_bytes(handle, parent, path.part[3], 2, stage_bytes, stage_length);
  if (!error) error = compare_file_bytes(handle, handle->recovery_fd, stage, 2, main_bytes, main_length);
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = check_file_identity(handle, parent, path.part[3], &stage_before);
  if (!error) error = check_file_identity(handle, handle->recovery_fd, stage, &main_before);
  free(main_bytes); free(stage_bytes); close_chain(&chain);
  return error ? failure(env, swapped ? "MOVED_NEEDS_REVIEW" : error) : undefined(env);
}

static napi_value archive_rename_main(napi_env env, napi_callback_info info) {
  napi_value args[4]; archive_handle *handle; archive_path from, to; directory_chain chain = {0};
  struct stat before, current; int parent = -1; bool moved = false; unsigned char *bytes = NULL; size_t length = 0;
  const char *error = personal_arguments(env, info, 4, args, &handle);
  if (!error) error = main_path(env, args[1], &from);
  if (!error) error = main_path(env, args[2], &to);
  if (!error && strcmp(from.part[2], to.part[2])) error = "PATH_NOT_ALLOWED";
  if (!error) error = open_chain(handle, &from, 3, &chain);
  if (!error) {
    parent = chain_fd(handle, &chain);
    if (fstatat(parent, from.part[3], &before, AT_SYMLINK_NOFOLLOW)) error = system_error();
  }
  if (!error) error = safe_node(handle, &before);
  if (!error && (!S_ISREG(before.st_mode) || before.st_uid != getuid())) error = "PATH_NOT_ALLOWED";
  if (!error) error = expected_identity(env, args[3], &before);
  if (!error) error = read_bytes(handle, parent, from.part[3], MAX_FILE_BYTES, 0, &bytes, &length);
  if (!error) error = check_chain(handle, &chain);
  if (!error && (fstatat(parent, from.part[3], &current, AT_SYMLINK_NOFOLLOW) || !same_version(&before, &current))) error = "SOURCE_IDENTITY_CHANGED";
  if (!error) {
    if (renameatx_np(parent, from.part[3], parent, to.part[3], RENAME_EXCL | RENAME_NOFOLLOW_ANY)) error = system_error();
    else moved = true;
  }
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = check_file_identity(handle, parent, to.part[3], &before);
  if (!error && (fstatat(parent, from.part[3], &current, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT)) error = "SOURCE_IDENTITY_CHANGED";
  if (!error && fsync(parent)) error = "IO_ERROR";
  if (!error) error = compare_file_bytes(handle, parent, to.part[3], 0, bytes, length);
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = check_file_identity(handle, parent, to.part[3], &before);
  if (!error && (fstatat(parent, from.part[3], &current, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT)) error = "SOURCE_IDENTITY_CHANGED";
  free(bytes); close_chain(&chain);
  return error ? failure(env, moved ? "MOVED_NEEDS_REVIEW" : error) : undefined(env);
}

static napi_value open_personal_child(napi_env env, napi_callback_info info, int kind) {
  napi_value args[2]; archive_handle *owner = NULL;
  const char *error = personal_arguments(env, info, 2, args, &owner);
  if (error) return failure(env, error);
  archive_handle *handle = calloc(1, sizeof(*handle));
  if (!handle) return failure(env, "IO_ERROR");
  handle->root_fd = -1; handle->recovery_fd = -1;
  handle->personal = true; handle->ingestion = kind == 1; handle->trash = kind == 2;
  handle->intake_trash = kind == 3; handle->owner = owner;
  strcpy(handle->root, owner->root); handle->root_stat = owner->root_stat;
  memcpy(handle->core_stat, owner->core_stat, sizeof(handle->core_stat));
  error = js_string(env, args[1], handle->recovery_root, sizeof(handle->recovery_root));
  if (!error && (nested_root(handle->root, handle->recovery_root) || nested_root(handle->recovery_root, handle->root)
      || nested_root(owner->recovery_root, handle->recovery_root) || nested_root(handle->recovery_root, owner->recovery_root))) error = "PATH_NOT_ALLOWED";
  if (!error) {
    // dup shares the existing flock. Never acquire or unlock the archive lock here.
    handle->root_fd = fcntl(owner->root_fd, F_DUPFD_CLOEXEC, 0);
    if (handle->root_fd < 0) error = "IO_ERROR";
  }
  if (!error) {
    handle->recovery_fd = absolute_directory(handle->recovery_root);
    if (handle->recovery_fd < 0 || fstat(handle->recovery_fd, &handle->recovery_stat)
        || !private_node(&handle->recovery_stat, 0700, true)) error = "PATH_NOT_ALLOWED";
    else if (handle->recovery_stat.st_dev != handle->root_stat.st_dev) error = "CROSS_DEVICE";
    else if (same_identity(&handle->recovery_stat, &owner->recovery_stat)) error = "PATH_NOT_ALLOWED";
  }
  if (!error && flock(handle->recovery_fd, LOCK_EX | LOCK_NB)) error = errno == EWOULDBLOCK ? "RECOVERY_LOCKED" : "IO_ERROR";
  if (!error && handle->intake_trash) {
    archive_path path = { .bytes = "01图书馆/小兆clipper" }; directory_chain chain = {0};
    error = split_path(&path);
    if (!error) error = open_chain(handle, &path, path.count, &chain);
    if (!error) handle->intake_stat = chain.identity[chain.count - 1];
    close_chain(&chain);
  }
  if (!error) error = check_handle(handle);
  if (!error && napi_create_reference(env, args[0], 1, &handle->owner_ref) != napi_ok) error = "IO_ERROR";
  if (error) { close_handle(handle); free(handle); return failure(env, error); }
  napi_value external;
  if (napi_create_external(env, handle, finalize, NULL, &external) != napi_ok) {
    napi_delete_reference(env, handle->owner_ref); close_handle(handle); free(handle); return failure(env, "IO_ERROR");
  }
  if (napi_type_tag_object(env, external, kind == 3 ? &intake_trash_tag : kind == 2 ? &trash_tag : &ingestion_tag) != napi_ok) { close_handle(handle); return failure(env, "IO_ERROR"); }
  return external;
}

static napi_value archive_open_ingestion(napi_env env, napi_callback_info info) {
  return open_personal_child(env, info, 1);
}

static napi_value archive_open_trash(napi_env env, napi_callback_info info) {
  return open_personal_child(env, info, 2);
}

static napi_value archive_open_intake_trash(napi_env env, napi_callback_info info) {
  return open_personal_child(env, info, 3);
}

static const char *ingestion_path(napi_env env, napi_value value, archive_path *path) {
  const char *error = js_string(env, value, path->bytes, sizeof(path->bytes));
  if (error || (error = split_path(path))) return error;
  if (path->count < 2) return "PATH_NOT_ALLOWED";
  if (strcmp(path->part[0], "02知识库") && (strcmp(path->part[0], "01图书馆")
      || path->count < 3 || !valid_platform(path->part[1]))) return "PATH_NOT_ALLOWED";
  const char *name = path->part[path->count - 1]; size_t length = strlen(name);
  return length > 3 && !strcmp(name + length - 3, ".md") ? NULL : "PATH_NOT_ALLOWED";
}

static napi_value ingestion_read(napi_env env, napi_callback_info info) {
  napi_value args[2]; archive_handle *handle; archive_path path; directory_chain chain = {0};
  unsigned char *bytes = NULL; size_t length = 0; bool missing = false;
  const char *error = personal_arguments(env, info, 2, args, &handle);
  if (!error) error = ingestion_path(env, args[1], &path);
  if (!error) error = open_chain(handle, &path, path.count - 1, &chain);
  if (!error) error = read_bytes(handle, chain_fd(handle, &chain), path.part[path.count - 1], MAX_FILE_BYTES, 2, &bytes, &length);
  if (error && !strcmp(error, "NOT_FOUND")) { error = NULL; missing = true; }
  if (!error) error = check_chain(handle, &chain);
  close_chain(&chain);
  if (error) { free(bytes); return failure(env, error); }
  return missing ? null_value(env) : buffer_value(env, bytes, length);
}

static const char *copy_buffer(napi_env env, napi_value value, unsigned char **bytes, size_t *length) {
  bool is_buffer = false; void *source = NULL;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer
      || napi_get_buffer_info(env, value, &source, length) != napi_ok) return "INVALID_ARGUMENT";
  if (*length > MAX_FILE_BYTES) return "FILE_TOO_LARGE";
  *bytes = malloc(*length + 1);
  if (!*bytes) return "IO_ERROR";
  if (*length) memcpy(*bytes, source, *length);
  return NULL;
}

static const char *hold_ingestion_file(archive_handle *handle, int parent, const char *name, int *fd, struct stat *identity) {
  if (fstatat(parent, name, identity, AT_SYMLINK_NOFOLLOW)) return system_error();
  const char *error = safe_node(handle, identity);
  if (error) return error;
  if (!preserved_stage_node(identity)) return "PATH_NOT_ALLOWED";
  if (identity->st_size < 0 || (uintmax_t)identity->st_size > MAX_FILE_BYTES) return "FILE_TOO_LARGE";
  *fd = openat(parent, name, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
  if (*fd < 0) return system_error();
  struct stat opened;
  return fstat(*fd, &opened) || !same_version(identity, &opened) ? "VERSION_CONFLICT" : NULL;
}

static const char *verify_ingestion_file(archive_handle *handle, int parent, const char *name, int fd,
    const struct stat *identity, const unsigned char *expected, size_t length, bool original_version) {
  struct stat before, after, named;
  if (fstat(fd, &before) || !same_identity(&before, identity)
      || (original_version && !same_version(&before, identity))) return "VERSION_CONFLICT";
  const char *error = safe_node(handle, &before);
  if (error) return error;
  if (!preserved_stage_node(&before)) return "PATH_NOT_ALLOWED";
  if (before.st_size != (off_t)length) return "VERSION_CONFLICT";
  unsigned char chunk[65536]; size_t offset = 0;
  while (offset < length) {
    size_t wanted = length - offset < sizeof(chunk) ? length - offset : sizeof(chunk);
    ssize_t count = pread(fd, chunk, wanted, (off_t)offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 || memcmp(chunk, expected + offset, (size_t)count)) return "VERSION_CONFLICT";
    offset += (size_t)count;
  }
  if (fstat(fd, &after) || !same_version(&before, &after)
      || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) || !same_version(&after, &named)) return "VERSION_CONFLICT";
  return NULL;
}

static napi_value ingestion_apply(napi_env env, napi_callback_info info) {
  napi_value args[5]; archive_handle *handle; archive_path path; directory_chain chain = {0};
  char stage[64]; unsigned char *before = NULL, *after = NULL; size_t before_length = 0, after_length = 0;
  int parent = -1, source_fd = -1, stage_fd = -1; struct stat source_stat, stage_stat, current;
  bool create = false, moved = false; const char *name = NULL;
  const char *error = personal_arguments(env, info, 5, args, &handle);
  if (!error) error = ingestion_path(env, args[1], &path);
  if (!error) error = recovery_argument(env, args[2], stage);
  if (!error && !stage_name(stage)) error = "PATH_NOT_ALLOWED";
  napi_valuetype before_type;
  if (!error && napi_typeof(env, args[3], &before_type) != napi_ok) error = "INVALID_ARGUMENT";
  if (!error) create = before_type == napi_null;
  if (!error && create && strcmp(path.part[0], "02知识库")) error = "PATH_NOT_ALLOWED";
  if (!error && !create) error = copy_buffer(env, args[3], &before, &before_length);
  if (!error) error = copy_buffer(env, args[4], &after, &after_length);
  if (!error) error = open_chain(handle, &path, path.count - 1, &chain);
  if (!error) {
    parent = chain_fd(handle, &chain); name = path.part[path.count - 1];
    if (create) {
      if (!fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW)) error = "TARGET_EXISTS";
      else if (errno != ENOENT) error = system_error();
    } else error = hold_ingestion_file(handle, parent, name, &source_fd, &source_stat);
  }
  if (!error) error = hold_ingestion_file(handle, handle->recovery_fd, stage, &stage_fd, &stage_stat);
  if (!error && !create) error = verify_ingestion_file(handle, parent, name, source_fd, &source_stat, before, before_length, true);
  if (!error) error = verify_ingestion_file(handle, handle->recovery_fd, stage, stage_fd, &stage_stat, after, after_length, true);
  if (!error && (fsync(stage_fd) || (!create && fsync(source_fd)))) error = "IO_ERROR";
  if (!error) error = check_chain(handle, &chain);
  // Last preflight: no path-based operation can provide an atomic byte-hash CAS.
  // A noncooperating writer can still race the rename; postflight detects it and
  // leaves the swapped inode and every recovery artifact available for review.
  if (!error && !create) error = verify_ingestion_file(handle, parent, name, source_fd, &source_stat, before, before_length, true);
  if (!error) error = verify_ingestion_file(handle, handle->recovery_fd, stage, stage_fd, &stage_stat, after, after_length, true);
  if (!error) {
    unsigned flags = (create ? RENAME_EXCL : RENAME_SWAP) | RENAME_NOFOLLOW_ANY;
    if (renameatx_np(handle->recovery_fd, stage, parent, name, flags)) error = system_error();
    else moved = true;
  }
  // Attempt durability even when subsequent checks discover a race. Never unlink
  // or roll back here: doing so could remove a concurrent external version.
  if (moved) {
    bool sync_failed = fsync(stage_fd) != 0;
    if (source_fd >= 0 && fsync(source_fd)) sync_failed = true;
    if (fsync(parent)) sync_failed = true;
    if (fsync(handle->recovery_fd)) sync_failed = true;
    if (sync_failed) error = "IO_ERROR";
  }
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = verify_ingestion_file(handle, parent, name, stage_fd, &stage_stat, after, after_length, false);
  if (!error && !create) error = verify_ingestion_file(handle, handle->recovery_fd, stage, source_fd, &source_stat, before, before_length, false);
  if (!error && create && (!fstatat(handle->recovery_fd, stage, &current, AT_SYMLINK_NOFOLLOW) || errno != ENOENT)) error = "VERSION_CONFLICT";
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = verify_ingestion_file(handle, parent, name, stage_fd, &stage_stat, after, after_length, false);
  if (!error && !create) error = verify_ingestion_file(handle, handle->recovery_fd, stage, source_fd, &source_stat, before, before_length, false);
  if (source_fd >= 0) close(source_fd);
  if (stage_fd >= 0) close(stage_fd);
  free(before); free(after); close_chain(&chain);
  return error ? failure(env, moved ? "INGESTION_NEEDS_REVIEW" : error) : undefined(env);
}

static const char *trash_path(napi_env env, napi_value value, archive_path *path) {
  // The ingestion path grammar already restricts both origins to one Markdown
  // leaf; hold_ingestion_file excludes directories, links and unsafe modes.
  return ingestion_path(env, value, path);
}

static bool trash_item_name(const char *name) {
  if (strlen(name) != 39 || strcmp(name + 36, ".md")) return false;
  char intent[64]; memcpy(intent, name, 36); strcpy(intent + 36, ".intent.json");
  return trash_recovery_name(intent);
}

static const char *trash_item_argument(napi_env env, napi_value value, char *name) {
  char id[64]; const char *error = js_string(env, value, id, sizeof(id));
  if (error) return error;
  if (strlen(id) != 36) return "PATH_NOT_ALLOWED";
  memcpy(name, id, 36); strcpy(name + 36, ".md");
  return trash_item_name(name) ? NULL : "PATH_NOT_ALLOWED";
}

static napi_value trash_access(napi_env env, napi_callback_info info, bool item, bool read_content) {
  napi_value args[2]; archive_handle *handle; archive_path path; directory_chain chain = {0};
  char item_name[64]; const char *name = NULL; int parent = -1, held = -1;
  struct stat before, current; unsigned char *bytes = NULL; size_t length = 0; bool missing = false;
  const char *error = personal_arguments(env, info, 2, args, &handle);
  if (!error) error = item ? trash_item_argument(env, args[1], item_name) : trash_path(env, args[1], &path);
  if (!error && !item) error = open_chain(handle, &path, path.count - 1, &chain);
  if (!error) {
    parent = item ? handle->recovery_fd : chain_fd(handle, &chain);
    name = item ? item_name : path.part[path.count - 1];
    error = hold_ingestion_file(handle, parent, name, &held, &before);
  }
  if (!error && read_content) error = read_bytes(handle, parent, name, MAX_FILE_BYTES, 2, &bytes, &length);
  if (error && !strcmp(error, "NOT_FOUND")) { error = NULL; missing = true; }
  if (!error && !missing && (fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW)
      || !same_version(&before, &current))) error = "VERSION_CONFLICT";
  if (!error) error = check_chain(handle, &chain);
  if (held >= 0) close(held);
  close_chain(&chain);
  if (error) { free(bytes); return failure(env, error); }
  if (missing) { free(bytes); return null_value(env); }
  return read_content ? buffer_value(env, bytes, length) : identity_value(env, &before, true);
}

static napi_value trash_stat(napi_env env, napi_callback_info info) { return trash_access(env, info, false, false); }
static napi_value trash_read(napi_env env, napi_callback_info info) { return trash_access(env, info, false, true); }
static napi_value trash_stat_item(napi_env env, napi_callback_info info) { return trash_access(env, info, true, false); }
static napi_value trash_read_item(napi_env env, napi_callback_info info) { return trash_access(env, info, true, true); }

static napi_value trash_transfer(napi_env env, napi_callback_info info, bool restore) {
  napi_value args[4]; archive_handle *handle; archive_path path; directory_chain chain = {0};
  char item[64]; int parent = -1, from = -1, to = -1, held = -1; const char *source = NULL, *target = NULL;
  struct stat before, current; unsigned char *bytes = NULL; size_t length = 0; bool moved = false;
  const char *error = personal_arguments(env, info, 4, args, &handle);
  if (!error) error = trash_path(env, args[restore ? 2 : 1], &path);
  if (!error) error = trash_item_argument(env, args[restore ? 1 : 2], item);
  if (!error) error = open_chain(handle, &path, path.count - 1, &chain);
  if (!error) {
    parent = chain_fd(handle, &chain);
    from = restore ? handle->recovery_fd : parent; to = restore ? parent : handle->recovery_fd;
    source = restore ? item : path.part[path.count - 1]; target = restore ? path.part[path.count - 1] : item;
    error = hold_ingestion_file(handle, from, source, &held, &before);
  }
  if (!error) error = expected_identity(env, args[3], &before);
  if (!error) {
    if (!fstatat(to, target, &current, AT_SYMLINK_NOFOLLOW)) error = "TARGET_EXISTS";
    else if (errno != ENOENT) error = system_error();
  }
  if (!error) error = read_bytes(handle, from, source, MAX_FILE_BYTES, 2, &bytes, &length);
  if (!error) error = verify_ingestion_file(handle, from, source, held, &before, bytes, length, true);
  if (!error && fsync(held)) error = "IO_ERROR";
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = verify_ingestion_file(handle, from, source, held, &before, bytes, length, true);
  // rename has no inode CAS. Keep the descriptor and original bytes through
  // postflight so a concurrent replacement cannot be silently called success.
  if (!error) {
    if (renameatx_np(from, source, to, target, RENAME_EXCL | RENAME_NOFOLLOW_ANY)) error = system_error();
    else moved = true;
  }
  if (moved) {
    bool sync_failed = fsync(held) != 0;
    if (fsync(parent)) sync_failed = true;
    if (fsync(handle->recovery_fd)) sync_failed = true;
    if (sync_failed) error = "IO_ERROR";
  }
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = verify_ingestion_file(handle, to, target, held, &before, bytes, length, false);
  if (!error && (fstat(held, &current) || current.st_mode != before.st_mode)) error = "VERSION_CONFLICT";
  if (!error && (!fstatat(from, source, &current, AT_SYMLINK_NOFOLLOW) || errno != ENOENT)) error = "SOURCE_IDENTITY_CHANGED";
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = verify_ingestion_file(handle, to, target, held, &before, bytes, length, false);
  if (held >= 0) close(held);
  free(bytes); close_chain(&chain);
  // Never roll back, overwrite, unlink or purge. Recovery inspects every version.
  return error ? failure(env, moved ? "TRASH_NEEDS_REVIEW" : error) : undefined(env);
}

static napi_value trash_move(napi_env env, napi_callback_info info) { return trash_transfer(env, info, false); }
static napi_value trash_restore(napi_env env, napi_callback_info info) { return trash_transfer(env, info, true); }

static napi_value trash_purge(napi_env env, napi_callback_info info) {
  napi_value args[4]; archive_handle *handle; char name[64]; int held = -1;
  struct stat before, after, current; unsigned char *bytes = NULL; size_t length = 0; bool deleted = false;
  const char *error = personal_arguments(env, info, 4, args, &handle);
  if (!error) error = trash_item_argument(env, args[1], name);
  if (!error) error = copy_buffer(env, args[3], &bytes, &length);
  if (!error) error = hold_ingestion_file(handle, handle->recovery_fd, name, &held, &before);
  if (!error) error = expected_identity(env, args[2], &before);
  if (!error) error = verify_ingestion_file(handle, handle->recovery_fd, name, held, &before, bytes, length, true);
  if (!error && fsync(held)) error = "IO_ERROR";
  if (!error) error = check_handle(handle);
  if (!error) error = verify_ingestion_file(handle, handle->recovery_fd, name, held, &before, bytes, length, true);
  // Only the selected UUID.md entry in the locked private recovery directory is
  // unlinked. macOS has no atomic inode-CAS unlink; an uncooperative same-user
  // writer can race this boundary. Postflight reports that outcome, never retries.
  if (!error) {
    if (unlinkat(handle->recovery_fd, name, 0)) error = system_error();
    else deleted = true;
  }
  if (deleted) {
    bool sync_failed = fsync(held) != 0;
    if (fsync(handle->recovery_fd)) sync_failed = true;
    if (sync_failed) error = "IO_ERROR";
  }
  if (!error) error = check_handle(handle);
  if (!error && (fstat(held, &after) || !same_identity(&before, &after) || after.st_nlink != 0
      || after.st_size != (off_t)length || after.st_mode != before.st_mode || after.st_uid != before.st_uid)) error = "VERSION_CONFLICT";
  unsigned char chunk[65536]; size_t offset = 0;
  while (!error && offset < length) {
    size_t wanted = length - offset < sizeof(chunk) ? length - offset : sizeof(chunk);
    ssize_t count = pread(held, chunk, wanted, (off_t)offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 || memcmp(chunk, bytes + offset, (size_t)count)) { error = "VERSION_CONFLICT"; break; }
    offset += (size_t)count;
  }
  if (!error && (fstat(held, &current) || !same_version(&after, &current))) error = "VERSION_CONFLICT";
  if (!error && (!fstatat(handle->recovery_fd, name, &current, AT_SYMLINK_NOFOLLOW) || errno != ENOENT)) error = "VERSION_CONFLICT";
  if (!error) error = check_handle(handle);
  if (held >= 0) close(held);
  free(bytes);
  return error ? failure(env, deleted ? "TRASH_DELETE_NEEDS_REVIEW" : error) : undefined(env);
}

static napi_value trash_list_recovery(napi_env env, napi_callback_info info) {
  napi_value args[1], result; archive_handle *handle; DIR *directory = NULL; struct stat before, after;
  const char *error = personal_arguments(env, info, 1, args, &handle);
  if (!error) {
    int copy = openat(handle->recovery_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (copy < 0) error = system_error();
    else if (!(directory = fdopendir(copy))) { close(copy); error = "IO_ERROR"; }
  }
  if (!error && (fstat(handle->recovery_fd, &before) || napi_create_array(env, &result) != napi_ok)) error = "IO_ERROR";
  unsigned entries = 0, journals = 0;
  while (!error) {
    errno = 0; struct dirent *entry = readdir(directory);
    if (!entry) { if (errno) error = "IO_ERROR"; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++entries > MAX_ENTRIES) { error = "DIRECTORY_TOO_LARGE"; break; }
    bool item = trash_item_name(entry->d_name);
    if (!item && !trash_recovery_name(entry->d_name)) { error = "PATH_NOT_ALLOWED"; break; }
    struct stat st;
    if (fstatat(handle->recovery_fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW)) { error = system_error(); break; }
    error = safe_node(handle, &st);
    if (!error && !(item ? preserved_stage_node(&st) : private_node(&st, 0600, false))) error = "PATH_NOT_ALLOWED";
    if (!error && (st.st_size < 0 || (uintmax_t)st.st_size > (item ? MAX_FILE_BYTES : MAX_RECOVERY_BYTES))) error = "FILE_TOO_LARGE";
    if (!error && !item) {
      napi_value value;
      if (napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &value) != napi_ok
          || napi_set_element(env, result, journals++, value) != napi_ok) error = "IO_ERROR";
    }
  }
  if (!error && (fstat(handle->recovery_fd, &after) || !same_version(&before, &after))) error = "VERSION_CONFLICT";
  if (!error) error = check_handle(handle);
  if (directory) closedir(directory);
  return error ? failure(env, error) : result;
}

static bool intake_item_name(const char *name) {
  if (strlen(name) != 43 || strcmp(name + 36, ".packet")) return false;
  char intent[64]; memcpy(intent, name, 36); strcpy(intent + 36, ".intent.json");
  return recovery_name(intent);
}

// Callers supply only a top-level intake name or a UUID, followed by optional
// descendant segments. Neither reader accepts a vault path or recovery filename.
static const char *intake_path(napi_env env, napi_value value, archive_path *path, bool item, bool top_only) {
  archive_path input = {0}; char original[PATH_MAX];
  const char *error = js_string(env, value, original, sizeof(original));
  if (error) return error;
  strcpy(input.bytes, original);
  if ((error = split_path(&input))) return error;
  if ((top_only && input.count != 1) || input.count > MAX_PACKAGE_DEPTH + 1) return "PATH_NOT_ALLOWED";
  if (!strcmp(input.part[0], ".gitkeep")) return "PATH_NOT_ALLOWED";
  int length;
  if (item) {
    char slot[64];
    if (strlen(input.part[0]) != 36) return "PATH_NOT_ALLOWED";
    snprintf(slot, sizeof(slot), "%s.packet", input.part[0]);
    if (!intake_item_name(slot)) return "PATH_NOT_ALLOWED";
    length = snprintf(path->bytes, sizeof(path->bytes), "%s%s", slot, original + 36);
  } else length = snprintf(path->bytes, sizeof(path->bytes), "01图书馆/小兆clipper/%s", original);
  if (length < 0 || (size_t)length >= sizeof(path->bytes)) return "PATH_NOT_ALLOWED";
  return split_path(path);
}

static napi_value intake_access(napi_env env, napi_callback_info info, bool item, int operation) {
  napi_value args[2], result; archive_handle *handle; archive_path path; directory_chain chain = {0};
  unsigned char *bytes = NULL; size_t length = 0; struct stat st; bool missing = false; int base = -1;
  const char *error = personal_arguments(env, info, 2, args, &handle);
  if (!error) error = intake_path(env, args[1], &path, item, false);
  if (!error) {
    base = item ? handle->recovery_fd : handle->root_fd;
    error = open_chain_at(handle, base, &path, path.count - (operation == 1 ? 0 : 1), &chain);
  }
  int parent = chain.count ? chain.fd[chain.count - 1] : base;
  if (!error && operation == 0) {
    if (fstatat(parent, path.part[path.count - 1], &st, AT_SYMLINK_NOFOLLOW)) error = system_error();
    else error = safe_node(handle, &st);
  }
  if (!error && operation == 1) error = list_directory(env, handle, parent, false, &result);
  if (!error && operation == 2) error = read_bytes(handle, parent, path.part[path.count - 1], MAX_FILE_BYTES, 0, &bytes, &length);
  if (operation == 0 && error && !strcmp(error, "NOT_FOUND")) { missing = true; error = NULL; }
  if (!error) error = check_chain_at(handle, base, &chain);
  close_chain(&chain);
  if (error) { free(bytes); return failure(env, error); }
  if (operation == 0) return missing ? null_value(env) : identity_value(env, &st, true);
  return operation == 1 ? result : buffer_value(env, bytes, length);
}

static napi_value intake_source_stat(napi_env env, napi_callback_info info) { return intake_access(env, info, false, 0); }
static napi_value intake_source_list(napi_env env, napi_callback_info info) { return intake_access(env, info, false, 1); }
static napi_value intake_source_read(napi_env env, napi_callback_info info) { return intake_access(env, info, false, 2); }
static napi_value intake_item_stat(napi_env env, napi_callback_info info) { return intake_access(env, info, true, 0); }
static napi_value intake_item_list(napi_env env, napi_callback_info info) { return intake_access(env, info, true, 1); }
static napi_value intake_item_read(napi_env env, napi_callback_info info) { return intake_access(env, info, true, 2); }

typedef struct {
  int fd;
  size_t parent;
  size_t children;
  char *name;
  char *relative;
  struct stat version;
  unsigned char *bytes;
} held_intake_entry;

typedef struct {
  held_intake_entry *entries;
  size_t count;
  size_t bytes;
} held_intake_tree;

static void close_intake_tree(held_intake_tree *tree) {
  for (size_t i = 0; i < tree->count; i++) {
    close(tree->entries[i].fd); free(tree->entries[i].name); free(tree->entries[i].relative); free(tree->entries[i].bytes);
  }
  free(tree->entries); tree->entries = NULL; tree->count = 0;
}

static const char *hold_intake_tree(archive_handle *handle, held_intake_tree *tree, int parent_fd,
    const char *name, size_t parent_index, int depth, size_t length) {
  if (depth > MAX_PACKAGE_DEPTH || length >= PATH_MAX || !valid_name(name)) return "PATH_NOT_ALLOWED";
  if (tree->count >= MAX_ENTRIES) return "DIRECTORY_TOO_LARGE";
  struct stat before, opened, after;
  if (fstatat(parent_fd, name, &before, AT_SYMLINK_NOFOLLOW)) return system_error();
  const char *error = safe_node(handle, &before);
  if (error) return error;
  if (S_ISREG(before.st_mode) && (before.st_size < 0 || (uintmax_t)before.st_size > MAX_FILE_BYTES
      || (uintmax_t)before.st_size + tree->bytes > MAX_RECOVERY_BYTES)) return "FILE_TOO_LARGE";
  int fd = openat(parent_fd, name, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW | (S_ISDIR(before.st_mode) ? O_DIRECTORY : 0));
  if (fd < 0) return system_error();
  size_t index = tree->count++;
  held_intake_entry *entry = &tree->entries[index];
  entry->fd = fd; entry->parent = parent_index; entry->version = before; entry->name = strdup(name);
  if (!entry->name) return "IO_ERROR";
  if (!index) entry->relative = strdup("");
  else {
    const char *prefix = tree->entries[parent_index].relative;
    size_t size = strlen(prefix) + strlen(name) + 2;
    entry->relative = malloc(size);
    if (entry->relative) snprintf(entry->relative, size, "%s%s%s", prefix, *prefix ? "/" : "", name);
  }
  if (!entry->relative) return "IO_ERROR";
  if (fstat(fd, &opened) || !same_version(&before, &opened) || before.st_gid != opened.st_gid) return "VERSION_CONFLICT";
  if (S_ISREG(before.st_mode)) {
    size_t size = (size_t)before.st_size, offset = 0;
    entry->bytes = malloc(size + 1);
    if (!entry->bytes) return "IO_ERROR";
    tree->bytes += size;
    while (offset < size) {
      ssize_t count = pread(fd, entry->bytes + offset, size - offset, (off_t)offset);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) return "VERSION_CONFLICT";
      offset += (size_t)count;
    }
  } else {
    int copy = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (copy < 0) return system_error();
    DIR *directory = fdopendir(copy);
    if (!directory) { close(copy); return "IO_ERROR"; }
    while (!error) {
      errno = 0; struct dirent *child = readdir(directory);
      if (!child) { if (errno) error = "IO_ERROR"; break; }
      if (!strcmp(child->d_name, ".") || !strcmp(child->d_name, "..")) continue;
      entry->children++;
      error = hold_intake_tree(handle, tree, fd, child->d_name, index, depth + 1, length + 1 + strlen(child->d_name));
    }
    closedir(directory);
  }
  if (!error && (fstat(fd, &after) || !same_version(&before, &after) || before.st_gid != after.st_gid
      || fstatat(parent_fd, name, &opened, AT_SYMLINK_NOFOLLOW) || !same_version(&after, &opened))) error = "VERSION_CONFLICT";
  return error;
}

static bool intake_same_version(const struct stat *before, const struct stat *after, bool renamed_root) {
  struct stat expected = *before;
  if (renamed_root) expected.st_ctimespec = after->st_ctimespec;
  return same_version(&expected, after) && expected.st_gid == after->st_gid;
}

static const char *verify_intake_tree(archive_handle *handle, const held_intake_tree *tree, int root_parent,
    const char *root_name, bool moved) {
  unsigned char chunk[65536];
  for (size_t i = 0; i < tree->count; i++) {
    const held_intake_entry *entry = &tree->entries[i]; struct stat opened, linked, after;
    int parent = i ? tree->entries[entry->parent].fd : root_parent;
    const char *name = i ? entry->name : root_name;
    if (fstat(entry->fd, &opened) || fstatat(parent, name, &linked, AT_SYMLINK_NOFOLLOW)) return "VERSION_CONFLICT";
    const char *error = safe_node(handle, &linked);
    if (error) return error;
    if (!intake_same_version(&entry->version, &opened, moved && i == 0)
        || !same_version(&opened, &linked) || opened.st_gid != linked.st_gid) return "VERSION_CONFLICT";
    if (S_ISREG(opened.st_mode)) {
      size_t length = (size_t)opened.st_size, offset = 0;
      while (offset < length) {
        size_t wanted = length - offset < sizeof(chunk) ? length - offset : sizeof(chunk);
        ssize_t count = pread(entry->fd, chunk, wanted, (off_t)offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0 || memcmp(chunk, entry->bytes + offset, (size_t)count)) return "VERSION_CONFLICT";
        offset += (size_t)count;
      }
    } else {
      int copy = openat(entry->fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      if (copy < 0) return system_error();
      DIR *directory = fdopendir(copy);
      if (!directory) { close(copy); return "IO_ERROR"; }
      size_t count = 0;
      while (!error) {
        errno = 0; struct dirent *child = readdir(directory);
        if (!child) { if (errno) error = "IO_ERROR"; break; }
        if (!strcmp(child->d_name, ".") || !strcmp(child->d_name, "..")) continue;
        if (!valid_name(child->d_name) || ++count > entry->children) error = "VERSION_CONFLICT";
      }
      closedir(directory);
      if (!error && count != entry->children) error = "VERSION_CONFLICT";
      if (error) return error;
    }
    if (fstat(entry->fd, &after) || !same_version(&opened, &after) || opened.st_gid != after.st_gid
        || fstatat(parent, name, &linked, AT_SYMLINK_NOFOLLOW) || !same_version(&after, &linked)) return "VERSION_CONFLICT";
  }
  return NULL;
}

static const char *sync_intake_tree(const held_intake_tree *tree) {
  bool failed = false;
  for (size_t i = tree->count; i > 0; i--) if (fsync(tree->entries[i - 1].fd)) failed = true;
  return failed ? "IO_ERROR" : NULL;
}

static napi_value intake_transfer(napi_env env, napi_callback_info info, bool restore) {
  napi_value args[4]; archive_handle *handle; archive_path path, slot; directory_chain chain = {0};
  held_intake_tree tree = {0}; struct stat current; bool moved = false;
  int from = -1, to = -1, parent = -1; const char *source = NULL, *target = NULL;
  const char *error = personal_arguments(env, info, 4, args, &handle);
  if (!error) error = intake_path(env, args[restore ? 2 : 1], &path, false, true);
  if (!error) error = intake_path(env, args[restore ? 1 : 2], &slot, true, true);
  if (!error) error = open_chain(handle, &path, path.count - 1, &chain);
  if (!error) {
    parent = chain_fd(handle, &chain); from = restore ? handle->recovery_fd : parent; to = restore ? parent : handle->recovery_fd;
    source = restore ? slot.part[0] : path.part[2]; target = restore ? path.part[2] : slot.part[0];
    tree.entries = calloc(MAX_ENTRIES, sizeof(*tree.entries));
    if (!tree.entries) error = "IO_ERROR";
  }
  if (!error) error = hold_intake_tree(handle, &tree, from, source, 0, 0,
    path_length(&path) > path_length(&slot) ? path_length(&path) : path_length(&slot));
  if (!error) error = expected_identity(env, args[3], &tree.entries[0].version);
  if (!error) {
    if (!fstatat(to, target, &current, AT_SYMLINK_NOFOLLOW)) error = "TARGET_EXISTS";
    else if (errno != ENOENT) error = system_error();
  }
  if (!error) error = verify_intake_tree(handle, &tree, from, source, false);
  if (!error) error = sync_intake_tree(&tree);
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = verify_intake_tree(handle, &tree, from, source, false);
  // macOS has no inode-CAS rename. Held descriptors and bytes detect replacement
  // after this boundary; retain both versions and journals for manual review.
  if (!error) {
    if (renameatx_np(from, source, to, target, RENAME_EXCL | RENAME_NOFOLLOW_ANY)) error = system_error();
    else moved = true;
  }
  if (moved) {
    error = sync_intake_tree(&tree);
    bool sync_failed = fsync(parent) != 0;
    if (fsync(handle->recovery_fd)) sync_failed = true;
    if (sync_failed) error = "IO_ERROR";
  }
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = verify_intake_tree(handle, &tree, to, target, true);
  if (!error && (!fstatat(from, source, &current, AT_SYMLINK_NOFOLLOW) || errno != ENOENT)) error = "SOURCE_IDENTITY_CHANGED";
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = verify_intake_tree(handle, &tree, to, target, true);
  close_intake_tree(&tree); close_chain(&chain);
  return error ? failure(env, moved ? "INTAKE_TRASH_NEEDS_REVIEW" : error) : undefined(env);
}

static napi_value intake_move(napi_env env, napi_callback_info info) { return intake_transfer(env, info, false); }
static napi_value intake_restore(napi_env env, napi_callback_info info) { return intake_transfer(env, info, true); }

/* Imports only a server-created, fixed four-member package. The selected user's
 * source is copied to private staging first; this operation never reads or moves
 * arbitrary original paths and never writes a formal library destination. */
static napi_value attachment_publish(napi_env env, napi_callback_info info) {
  napi_value args[7]; archive_handle *handle; directory_chain chain = {0}; archive_path path = {0};
  char staging[PATH_MAX] = {0}, name[64] = {0}, main_name[NAME_MAX + 1] = {0}, original_name[NAME_MAX + 1] = {0}, original_path[NAME_MAX + 16];
  void *main_bytes = NULL, *original_bytes = NULL; size_t main_length = 0, original_length = 0;
  held_intake_tree tree = {0}; int from = -1, to = -1; struct stat before, current; bool moved = false, is_buffer = false;
  const char *error = personal_arguments(env, info, 7, args, &handle);
  if (!error) error = js_string(env, args[1], staging, sizeof(staging));
  if (!error) error = js_string(env, args[2], name, sizeof(name));
  if (!error) error = js_string(env, args[3], main_name, sizeof(main_name));
  if (!error) error = js_string(env, args[5], original_name, sizeof(original_name));
  if (!error && (strlen(name) != 36 || !valid_name(name) || strspn(name, "abcdef0123456789-") != 36
      || !valid_name(main_name) || strlen(main_name) < 4 || strcmp(main_name + strlen(main_name) - 3, ".md")
      || (strcmp(original_name, "原件.pdf") && strcmp(original_name, "原件.md") && strcmp(original_name, "原件.txt"))
      || nested_root(handle->root, staging) || nested_root(staging, handle->root))) error = "PATH_NOT_ALLOWED";
  if (!error && (napi_is_buffer(env, args[4], &is_buffer) != napi_ok || !is_buffer
      || napi_get_buffer_info(env, args[4], &main_bytes, &main_length) != napi_ok)) error = "INVALID_ARGUMENT";
  if (!error && (napi_is_buffer(env, args[6], &is_buffer) != napi_ok || !is_buffer
      || napi_get_buffer_info(env, args[6], &original_bytes, &original_length) != napi_ok)) error = "INVALID_ARGUMENT";
  if (!error && (main_length > MAX_FILE_BYTES || original_length > MAX_FILE_BYTES || main_length + original_length > 16U * 1024U * 1024U)) error = "FILE_TOO_LARGE";
  if (!error) {
    from = absolute_directory(staging);
    if (from < 0 || fstat(from, &before) || !private_node(&before, 0700, true) || before.st_dev != handle->root_stat.st_dev) error = "PATH_NOT_ALLOWED";
  }
  if (!error) { strcpy(path.bytes, "01图书馆/小兆clipper"); error = split_path(&path); }
  if (!error) error = open_chain(handle, &path, path.count, &chain);
  if (!error) {
    to = chain_fd(handle, &chain); tree.entries = calloc(MAX_ENTRIES, sizeof(*tree.entries));
    if (!tree.entries) error = "IO_ERROR";
  }
  if (!error) error = hold_intake_tree(handle, &tree, from, name, 0, 0, strlen(staging) + strlen(name) + 1);
  if (!error && tree.count != 4) error = "PATH_NOT_ALLOWED";
  snprintf(original_path, sizeof(original_path), "附件/%s", original_name);
  for (size_t index = 0; !error && index < tree.count; index++) {
    held_intake_entry *entry = &tree.entries[index]; const char *relative = entry->relative;
    if (!strcmp(relative, "") || !strcmp(relative, "附件")) { if (!S_ISDIR(entry->version.st_mode)) error = "PATH_NOT_ALLOWED"; }
    else {
      const void *expected = !strcmp(relative, main_name) ? main_bytes : !strcmp(relative, original_path) ? original_bytes : NULL;
      size_t length = !strcmp(relative, main_name) ? main_length : original_length;
      if (!expected || !S_ISREG(entry->version.st_mode) || entry->version.st_size != (off_t)length || memcmp(entry->bytes, expected, length)) error = "VERSION_CONFLICT";
    }
  }
  if (!error) { if (!fstatat(to, name, &current, AT_SYMLINK_NOFOLLOW)) error = "TARGET_EXISTS"; else if (errno != ENOENT) error = system_error(); }
  if (!error) error = verify_intake_tree(handle, &tree, from, name, false);
  if (!error) error = sync_intake_tree(&tree);
  if (!error) error = check_chain(handle, &chain);
  if (!error) {
    int current_fd = absolute_directory(staging);
    if (current_fd < 0 || fstat(current_fd, &current) || !same_identity(&before, &current)) error = "PARENT_IDENTITY_CHANGED";
    if (current_fd >= 0) close(current_fd);
  }
  if (!error) error = verify_intake_tree(handle, &tree, from, name, false);
  if (!error) { if (renameatx_np(from, name, to, name, RENAME_EXCL | RENAME_NOFOLLOW_ANY)) error = system_error(); else moved = true; }
  if (moved) { error = sync_intake_tree(&tree); if (fsync(from) || fsync(to)) error = "IO_ERROR"; }
  if (!error) error = check_chain(handle, &chain);
  if (!error) error = verify_intake_tree(handle, &tree, to, name, true);
  if (!error && (!fstatat(from, name, &current, AT_SYMLINK_NOFOLLOW) || errno != ENOENT)) error = "SOURCE_IDENTITY_CHANGED";
  close_intake_tree(&tree); close_chain(&chain); if (from >= 0) close(from);
  return error ? failure(env, moved ? "ATTACHMENT_PUBLISH_NEEDS_REVIEW" : error) : undefined(env);
}

typedef struct { char *path; napi_value value; } intake_expected;

static const char *verify_purge_manifest(napi_env env, napi_value value, held_intake_tree *tree) {
  bool array = false; uint32_t count = 0;
  if (napi_is_array(env, value, &array) != napi_ok || !array || napi_get_array_length(env, value, &count) != napi_ok) return "INVALID_ARGUMENT";
  if (!count || count > 10000 || count != tree->count) return "VERSION_CONFLICT";
  intake_expected *expected = calloc(count, sizeof(*expected));
  if (!expected) return "IO_ERROR";
  const char *error = NULL;
  for (uint32_t i = 0; !error && i < count; i++) {
    napi_value path; char text[PATH_MAX];
    if (napi_get_element(env, value, i, &expected[i].value) != napi_ok
      || napi_get_named_property(env, expected[i].value, "path", &path) != napi_ok) error = "INVALID_ARGUMENT";
    if (!error) error = js_string(env, path, text, sizeof(text));
    if (!error && ((i == 0 && *text) || (i && strcmp(expected[i - 1].path, text) >= 0))) error = "PATH_NOT_ALLOWED";
    if (!error && *text) {
      archive_path relative = {0}; strcpy(relative.bytes, text); error = split_path(&relative);
      if (!error && relative.count > MAX_PACKAGE_DEPTH) error = "PATH_NOT_ALLOWED";
    }
    if (!error && !(expected[i].path = strdup(text))) error = "IO_ERROR";
  }
  for (size_t i = 0; !error && i < tree->count; i++) {
    held_intake_entry *entry = &tree->entries[i]; size_t low = 0, high = count;
    while (low < high) { size_t middle = low + (high - low) / 2; if (strcmp(expected[middle].path, entry->relative) < 0) low = middle + 1; else high = middle; }
    if (low == count || strcmp(expected[low].path, entry->relative)) { error = "VERSION_CONFLICT"; break; }
    napi_value member = expected[low].value, kind; char text[32];
    error = expected_identity(env, member, &entry->version);
    if (!error && napi_get_named_property(env, member, "kind", &kind) != napi_ok) error = "INVALID_ARGUMENT";
    if (!error) error = js_string(env, kind, text, sizeof(text));
    if (!error && strcmp(text, S_ISDIR(entry->version.st_mode) ? "directory" : "file")) error = "VERSION_CONFLICT";
    if (!error && S_ISREG(entry->version.st_mode)) {
      napi_value content; unsigned char *bytes = NULL; size_t length = 0;
      if (napi_get_named_property(env, member, "bytes", &content) != napi_ok) error = "INVALID_ARGUMENT";
      if (!error) error = copy_buffer(env, content, &bytes, &length);
      if (!error && (length != (size_t)entry->version.st_size || memcmp(bytes, entry->bytes, length))) error = "VERSION_CONFLICT";
      free(bytes);
    }
  }
  for (uint32_t i = 0; i < count; i++) free(expected[i].path);
  free(expected); return error;
}

static const char *purge_ancestry(archive_handle *handle, const held_intake_tree *tree, size_t index) {
  const char *error = check_handle(handle);
  while (!error) {
    const held_intake_entry *entry = &tree->entries[index]; struct stat opened, linked;
    int parent = index ? tree->entries[entry->parent].fd : handle->recovery_fd;
    if (fstat(entry->fd, &opened) || fstatat(parent, entry->name, &linked, AT_SYMLINK_NOFOLLOW)
      || !same_identity(&opened, &entry->version) || !same_version(&opened, &linked)
      || opened.st_mode != entry->version.st_mode || opened.st_uid != entry->version.st_uid
      || opened.st_gid != entry->version.st_gid) return "VERSION_CONFLICT";
    error = safe_node(handle, &linked);
    if (!index) break;
    index = entry->parent;
  }
  return error;
}

static const char *verify_purge_file(const held_intake_entry *entry, bool removed) {
  struct stat before, after; unsigned char chunk[65536]; size_t offset = 0, length = (size_t)entry->version.st_size;
  if (fstat(entry->fd, &before) || !same_identity(&before, &entry->version)
    || before.st_size != entry->version.st_size || before.st_mode != entry->version.st_mode
    || before.st_uid != entry->version.st_uid || before.st_gid != entry->version.st_gid
    || before.st_nlink != (removed ? 0 : 1)) return "VERSION_CONFLICT";
  if (!removed && !same_version(&entry->version, &before)) return "VERSION_CONFLICT";
  while (offset < length) {
    size_t wanted = length - offset < sizeof(chunk) ? length - offset : sizeof(chunk);
    ssize_t count = pread(entry->fd, chunk, wanted, (off_t)offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 || memcmp(chunk, entry->bytes + offset, (size_t)count)) return "VERSION_CONFLICT";
    offset += (size_t)count;
  }
  return fstat(entry->fd, &after) || !same_version(&before, &after) ? "VERSION_CONFLICT" : NULL;
}

static napi_value intake_purge(napi_env env, napi_callback_info info) {
  napi_value args[3]; archive_handle *handle; archive_path slot; held_intake_tree tree = {0}; bool removed = false;
  const char *error = personal_arguments(env, info, 3, args, &handle);
  if (!error) error = intake_path(env, args[1], &slot, true, true);
  if (!error && !(tree.entries = calloc(MAX_ENTRIES, sizeof(*tree.entries)))) error = "IO_ERROR";
  if (!error) error = hold_intake_tree(handle, &tree, handle->recovery_fd, slot.part[0], 0, 0, strlen(slot.part[0]));
  if (!error) error = verify_purge_manifest(env, args[2], &tree);
  if (!error) error = verify_intake_tree(handle, &tree, handle->recovery_fd, slot.part[0], false);
  if (!error) error = sync_intake_tree(&tree);
  // Reverse traversal removes only held, verified leaves. Every operation checks
  // the entire ancestry back to this UUID.packet in the locked recovery root.
  // macOS has no inode-CAS unlink; any detected race/partial result is terminal
  // for this invocation. Caller must obtain a new explicit user confirmation.
  for (size_t cursor = tree.count; !error && cursor > 0; cursor--) {
    size_t index = cursor - 1; held_intake_entry *entry = &tree.entries[index]; struct stat before, after;
    int parent = index ? tree.entries[entry->parent].fd : handle->recovery_fd;
    bool directory = S_ISDIR(entry->version.st_mode);
    error = purge_ancestry(handle, &tree, index);
    if (!error && directory) {
      if (entry->children || fstat(entry->fd, &before) || !same_version(&before, &entry->version)) error = "VERSION_CONFLICT";
    } else if (!error) error = verify_purge_file(entry, false);
    if (!error) error = purge_ancestry(handle, &tree, index);
    if (!error) {
      if (unlinkat(parent, entry->name, directory ? AT_REMOVEDIR : 0)) error = system_error();
      else removed = true;
    }
    if (!error && (fsync(parent) || fsync(entry->fd))) error = "IO_ERROR";
    if (!error && !directory) error = verify_purge_file(entry, true);
    // APFS retains a removed directory descriptor's link count (commonly 2).
    // Confirm its held identity and the named entry's absence instead.
    if (!error && directory && (fstat(entry->fd, &after) || !same_identity(&after, &entry->version)
      || after.st_mode != entry->version.st_mode || after.st_uid != entry->version.st_uid)) error = "VERSION_CONFLICT";
    if (!error && (!fstatat(parent, entry->name, &after, AT_SYMLINK_NOFOLLOW) || errno != ENOENT)) error = "VERSION_CONFLICT";
    if (!error && index) {
      held_intake_entry *ancestor = &tree.entries[entry->parent];
      if (!ancestor->children || fstat(parent, &after) || !same_identity(&after, &ancestor->version)
        || after.st_mode != ancestor->version.st_mode || after.st_uid != ancestor->version.st_uid
        || after.st_gid != ancestor->version.st_gid) error = "VERSION_CONFLICT";
      else { ancestor->children--; ancestor->version = after; }
      if (!error) error = purge_ancestry(handle, &tree, entry->parent);
    }
    if (!error) error = check_handle(handle);
  }
  close_intake_tree(&tree);
  return error ? failure(env, removed ? "INTAKE_TRASH_DELETE_NEEDS_REVIEW" : error) : undefined(env);
}

static napi_value intake_list_recovery(napi_env env, napi_callback_info info) {
  napi_value args[1], result; archive_handle *handle; DIR *directory = NULL; struct stat before, after;
  const char *error = personal_arguments(env, info, 1, args, &handle);
  if (!error) {
    int copy = openat(handle->recovery_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (copy < 0) error = system_error();
    else if (!(directory = fdopendir(copy))) { close(copy); error = "IO_ERROR"; }
  }
  if (!error && (fstat(handle->recovery_fd, &before) || napi_create_array(env, &result) != napi_ok)) error = "IO_ERROR";
  unsigned entries = 0, journals = 0;
  while (!error) {
    errno = 0; struct dirent *entry = readdir(directory);
    if (!entry) { if (errno) error = "IO_ERROR"; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++entries > MAX_ENTRIES) { error = "DIRECTORY_TOO_LARGE"; break; }
    bool item = intake_item_name(entry->d_name);
    if (!item && !intake_trash_recovery_name(entry->d_name)) { error = "PATH_NOT_ALLOWED"; break; }
    struct stat st;
    if (fstatat(handle->recovery_fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW)) { error = system_error(); break; }
    error = safe_node(handle, &st);
    if (!error && !item && !private_node(&st, 0600, false)) error = "PATH_NOT_ALLOWED";
    if (!error && S_ISREG(st.st_mode) && (st.st_size < 0 || (uintmax_t)st.st_size > (item ? MAX_FILE_BYTES : MAX_RECOVERY_BYTES))) error = "FILE_TOO_LARGE";
    if (!error && !item) {
      napi_value value;
      if (napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &value) != napi_ok
          || napi_set_element(env, result, journals++, value) != napi_ok) error = "IO_ERROR";
    }
  }
  if (!error && (fstat(handle->recovery_fd, &after) || !same_version(&before, &after))) error = "VERSION_CONFLICT";
  if (!error) error = check_handle(handle);
  if (directory) closedir(directory);
  return error ? failure(env, error) : result;
}
#endif

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    { "open", NULL, archive_open, NULL, NULL, NULL, napi_default, NULL },
    { "rootIdentity", NULL, archive_root_identity, NULL, NULL, NULL, napi_default, NULL },
    { "stat", NULL, archive_stat, NULL, NULL, NULL, napi_default, NULL },
    { "list", NULL, archive_list, NULL, NULL, NULL, napi_default, NULL },
    { "read", NULL, archive_read, NULL, NULL, NULL, napi_default, NULL },
    { "move", NULL, archive_move, NULL, NULL, NULL, napi_default, NULL },
    { "syncParents", NULL, archive_sync_parents, NULL, NULL, NULL, napi_default, NULL },
    { "readRecovery", NULL, archive_read_recovery, NULL, NULL, NULL, napi_default, NULL },
    { "writeRecovery", NULL, archive_write_recovery, NULL, NULL, NULL, napi_default, NULL },
    { "listRecovery", NULL, archive_list_recovery, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, archive_close, NULL, NULL, NULL, napi_default, NULL },
#ifdef PERSONAL_ARCHIVE
    { "openPersonal", NULL, archive_open_personal, NULL, NULL, NULL, napi_default, NULL },
    { "publishAttachmentPackage", NULL, attachment_publish, NULL, NULL, NULL, napi_default, NULL },
    { "listIntake", NULL, archive_list_intake, NULL, NULL, NULL, napi_default, NULL },
    { "ensureMonth", NULL, archive_ensure_month, NULL, NULL, NULL, napi_default, NULL },
    { "statRecovery", NULL, archive_stat_recovery, NULL, NULL, NULL, napi_default, NULL },
    { "swapMain", NULL, archive_swap_main, NULL, NULL, NULL, napi_default, NULL },
    { "renameMain", NULL, archive_rename_main, NULL, NULL, NULL, napi_default, NULL },
    { "openIngestion", NULL, archive_open_ingestion, NULL, NULL, NULL, napi_default, NULL },
    { "ingestionRootIdentity", NULL, archive_root_identity, NULL, NULL, NULL, napi_default, (void *)1 },
    { "ingestionRead", NULL, ingestion_read, NULL, NULL, NULL, napi_default, (void *)1 },
    { "ingestionReadRecovery", NULL, archive_read_recovery, NULL, NULL, NULL, napi_default, (void *)1 },
    { "ingestionWriteRecovery", NULL, archive_write_recovery, NULL, NULL, NULL, napi_default, (void *)1 },
    { "ingestionListRecovery", NULL, archive_list_recovery, NULL, NULL, NULL, napi_default, (void *)1 },
    { "ingestionApply", NULL, ingestion_apply, NULL, NULL, NULL, napi_default, (void *)1 },
    { "ingestionClose", NULL, archive_close, NULL, NULL, NULL, napi_default, (void *)1 },
    { "openTrash", NULL, archive_open_trash, NULL, NULL, NULL, napi_default, NULL },
    { "trashRootIdentity", NULL, archive_root_identity, NULL, NULL, NULL, napi_default, (void *)2 },
    { "trashStat", NULL, trash_stat, NULL, NULL, NULL, napi_default, (void *)2 },
    { "trashRead", NULL, trash_read, NULL, NULL, NULL, napi_default, (void *)2 },
    { "trashStatItem", NULL, trash_stat_item, NULL, NULL, NULL, napi_default, (void *)2 },
    { "trashReadItem", NULL, trash_read_item, NULL, NULL, NULL, napi_default, (void *)2 },
    { "trashMove", NULL, trash_move, NULL, NULL, NULL, napi_default, (void *)2 },
    { "trashRestore", NULL, trash_restore, NULL, NULL, NULL, napi_default, (void *)2 },
    { "trashPurge", NULL, trash_purge, NULL, NULL, NULL, napi_default, (void *)2 },
    { "trashReadRecovery", NULL, archive_read_recovery, NULL, NULL, NULL, napi_default, (void *)2 },
    { "trashWriteRecovery", NULL, archive_write_recovery, NULL, NULL, NULL, napi_default, (void *)2 },
    { "trashListRecovery", NULL, trash_list_recovery, NULL, NULL, NULL, napi_default, (void *)2 },
    { "trashClose", NULL, archive_close, NULL, NULL, NULL, napi_default, (void *)2 },
    { "openIntakeTrash", NULL, archive_open_intake_trash, NULL, NULL, NULL, napi_default, NULL },
    { "intakeTrashRootIdentity", NULL, archive_root_identity, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashSourceStat", NULL, intake_source_stat, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashSourceList", NULL, intake_source_list, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashSourceRead", NULL, intake_source_read, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashItemStat", NULL, intake_item_stat, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashItemList", NULL, intake_item_list, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashItemRead", NULL, intake_item_read, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashMove", NULL, intake_move, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashRestore", NULL, intake_restore, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashPurge", NULL, intake_purge, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashReadRecovery", NULL, archive_read_recovery, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashWriteRecovery", NULL, archive_write_recovery, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashListRecovery", NULL, intake_list_recovery, NULL, NULL, NULL, napi_default, (void *)3 },
    { "intakeTrashClose", NULL, archive_close, NULL, NULL, NULL, napi_default, (void *)3 },
#endif
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(sandbox_archive, initialize)

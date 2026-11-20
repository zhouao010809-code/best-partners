#ifndef VAULT_LAYOUT_H
#define VAULT_LAYOUT_H

#include <fcntl.h>
#include <stdbool.h>
#include <sys/stat.h>
#include <unistd.h>

// Match identifyVaultLayout's rule-file marker without following a rules-directory link.
static inline bool has_diary_layout(int root_fd) {
  int rules_fd = openat(root_fd, "00大脑规则", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (rules_fd < 0) return false;
  struct stat marker;
  bool present = fstatat(rules_fd, "03知识库规则.md", &marker, AT_SYMLINK_NOFOLLOW) == 0 && S_ISREG(marker.st_mode);
  close(rules_fd);
  return present;
}

#endif

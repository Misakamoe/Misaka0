/* Linux x86-64 only. No shell, external setup command, privileged helper or
 * caller-selected host path. Descriptors 3/4/5 are the verified executable,
 * exact runtime root and parent-owned input directory; 6 is the receipt pipe.
 * The host supervisor never interprets or executes a submitted program. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/magic.h>
#include <linux/seccomp.h>
#include <linux/securebits.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef POLICY_SHA256
#error POLICY_SHA256 must be supplied by the reviewed build script
#endif
#if !defined(__x86_64__)
#error Only the reviewed x86-64 syscall ABI is supported
#endif

enum { MAX_OUTPUT = 65536, MAX_FILES = 16, MAX_ARGS = 32 };
struct limits { long memory, cpu, pids, output, temporary, wall; };
static volatile sig_atomic_t cancelled;
static volatile sig_atomic_t test_cancelled;
static int cgparent = -1, cg = -1;
static int cgcreated;
static unsigned long measured_oom, measured_pids;
static int measured_cpu_children, measured_cancel_point;
static char cgname[80];
static void cancel_handler(int sig) { (void)sig; cancelled = 1; }
static void test_cancel_handler(int sig) { (void)sig; test_cancelled = 1; }
static void fail(void) { _exit(125); }
static long milliseconds(void) {
  struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) fail();
  return t.tv_sec * 1000L + t.tv_nsec / 1000000L;
}
static int write_all(int fd, const void *data, size_t n) {
  const char *p = data;
  while (n) { ssize_t k = write(fd, p, n); if (k < 0 && errno == EINTR) continue;
    if (k <= 0) return -1; p += k; n -= (size_t)k; }
  return 0;
}
static int text_at(int dir, const char *name, char *out, size_t size) {
  int fd = openat(dir, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  ssize_t n = read(fd, out, size - 1); int saved = errno; close(fd); errno = saved;
  if (n < 0 || (size_t)n == size - 1) return -1; out[n] = 0; return 0;
}
static int put_at(int dir, const char *name, const char *value) {
  int fd = openat(dir, name, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1; int result = write_all(fd, value, strlen(value));
  int saved = errno; close(fd); errno = saved; return result;
}
static int checked_limit(const char *name, const char *value) {
  char actual[128];
  if (put_at(cg, name, value) || text_at(cg, name, actual, sizeof(actual))) return -1;
  actual[strcspn(actual, "\n")] = 0; return strcmp(actual, value) ? -1 : 0;
}
static int open_absolute_directory(const char *path) {
  if (*path != '/') return -1;
  int fd = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC); char copy[4096];
  if (strlen(path) >= sizeof(copy)) { close(fd); return -1; }
  strcpy(copy, path); char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    if (!strcmp(part, ".") || !strcmp(part, "..")) { close(fd); return -1; }
    int next = openat(fd, part, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); close(fd);
    if (next < 0) return -1; fd = next;
  }
  return fd;
}
static int make_cgroup(struct limits l) {
  char membership[4096], path[4200], value[80]; struct statfs fs;
  int proc = open("/proc/self", O_DIRECTORY | O_CLOEXEC);
  if (proc < 0 || text_at(proc, "cgroup", membership, sizeof(membership))) { if (proc >= 0) close(proc); return -1; }
  close(proc);
  if (strncmp(membership, "0::/", 4) || strchr(membership + 4, '\n') != membership + strlen(membership) - 1) { errno = EINVAL; return -1; }
  membership[strcspn(membership, "\n")] = 0;
  snprintf(path, sizeof(path), "/sys/fs/cgroup%s", membership + 3);
  cgparent = open_absolute_directory(path);
  if (cgparent < 0 || fstatfs(cgparent, &fs) || fs.f_type != CGROUP2_SUPER_MAGIC) return -1;
  uint64_t nonce;
  if (getrandom(&nonce, sizeof(nonce), 0) != sizeof(nonce)) return -1;
  snprintf(cgname, sizeof(cgname), "misaka-local-%ld-%016lx", (long)getpid(), (unsigned long)nonce);
  if (mkdirat(cgparent, cgname, 0700)) return -1;
  cgcreated = 1;
  cg = openat(cgparent, cgname, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (cg < 0) return -1;
  snprintf(value, sizeof(value), "%ld", l.memory);
  if (checked_limit("memory.max", value) || checked_limit("memory.swap.max", "0") || checked_limit("memory.oom.group", "1")) return -1;
  snprintf(value, sizeof(value), "%ld", l.pids);
  if (checked_limit("pids.max", value) || checked_limit("cpu.max", "10000 100000")) return -1;
  int killfd = openat(cg, "cgroup.kill", O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (killfd < 0) return -1; close(killfd);
  return 0;
}
static int populated(void) {
  char value[256];
  if (text_at(cg, "cgroup.events", value, sizeof(value))) return -1;
  if (strstr(value, "populated 1\n")) return 1;
  return strstr(value, "populated 0\n") ? 0 : -1;
}
static long cpu_used(void) {
  char value[512]; unsigned long usage;
  if (text_at(cg, "cpu.stat", value, sizeof(value)) || sscanf(value, "usage_usec %lu", &usage) != 1) return -1;
  return (long)(usage / 1000);
}
static int destroy_cgroup(void) {
  if (cg >= 0) {
    if (put_at(cg, "cgroup.kill", "1") && populated() != 0) return -1;
    /* Never release the lease on an unverified drain. Even a stuck kernel task
     * keeps this supervisor and its caller pending, rather than admitting more. */
    for (;;) {
      int live = populated(); if (live < 0) return -1; if (!live) break;
      struct timespec pause = {0, 10000000}; nanosleep(&pause, NULL);
    }
    int status; while (waitpid(-1, &status, 0) > 0 || errno == EINTR) { }
    if (errno != ECHILD) return -1;
    close(cg); cg = -1;
  }
  if (cgparent >= 0) {
    if (cgcreated && unlinkat(cgparent, cgname, AT_REMOVEDIR)) return -1;
    close(cgparent); cgparent = -1; cgname[0] = 0; cgcreated = 0;
  }
  return 0;
}

#define ALLOW(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##n, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
static void seccomp_policy(void) {
  /* No socket/socketpair/connect, mount/namespace, ptrace/process_vm, bpf,
   * io_uring, userfaultfd, keyring, perf, device creation or privilege syscalls.
   * clone3 returns ENOSYS for libc's safe fallback; legacy clone cannot create
   * namespaces or share a filesystem with an unrelated parent. */
  struct sock_filter code[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    /* libc implements getrlimit via prlimit64. Permit only querying self, never
     * raising inherited hard limits or addressing a different process. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prlimit64, 0, 10),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2]) + 4),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 7),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]) + 4),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, ~(unsigned)(CSIGNAL | CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD | CLONE_SYSVSEM | CLONE_SETTLS | CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID | CLONE_CHILD_SETTID | CLONE_VFORK), 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    ALLOW(read), ALLOW(write), ALLOW(readv), ALLOW(writev), ALLOW(pread64), ALLOW(pwrite64),
    ALLOW(close), ALLOW(close_range), ALLOW(fstat), ALLOW(newfstatat), ALLOW(stat), ALLOW(lstat), ALLOW(statx), ALLOW(statfs), ALLOW(fstatfs),
    ALLOW(lseek), ALLOW(mmap), ALLOW(mprotect), ALLOW(munmap), ALLOW(mremap), ALLOW(madvise), ALLOW(brk),
    ALLOW(rt_sigaction), ALLOW(rt_sigprocmask), ALLOW(rt_sigreturn), ALLOW(sigaltstack),
    ALLOW(futex), ALLOW(set_tid_address), ALLOW(set_robust_list), ALLOW(rseq), ALLOW(arch_prctl),
    ALLOW(getpid), ALLOW(getppid), ALLOW(gettid), ALLOW(getuid), ALLOW(geteuid), ALLOW(getgid), ALLOW(getegid), ALLOW(getgroups),
    ALLOW(clock_gettime), ALLOW(clock_getres), ALLOW(gettimeofday), ALLOW(time), ALLOW(nanosleep), ALLOW(clock_nanosleep),
    ALLOW(getrandom), ALLOW(uname), ALLOW(sysinfo), ALLOW(getrusage), ALLOW(times), ALLOW(sched_yield), ALLOW(sched_getaffinity),
    ALLOW(getrlimit), ALLOW(getresuid), ALLOW(getresgid),
    ALLOW(open), ALLOW(openat), ALLOW(access), ALLOW(faccessat), ALLOW(faccessat2), ALLOW(getdents64),
    ALLOW(readlink), ALLOW(readlinkat), ALLOW(getcwd), ALLOW(chdir), ALLOW(fchdir),
    ALLOW(mkdir), ALLOW(mkdirat), ALLOW(rmdir), ALLOW(unlink), ALLOW(unlinkat), ALLOW(rename), ALLOW(renameat), ALLOW(renameat2),
    ALLOW(link), ALLOW(linkat), ALLOW(symlink), ALLOW(symlinkat), ALLOW(ftruncate), ALLOW(truncate),
    ALLOW(chmod), ALLOW(fchmod), ALLOW(fchmodat), ALLOW(umask), ALLOW(utimensat), ALLOW(fsync), ALLOW(fdatasync),
    ALLOW(fcntl), ALLOW(dup), ALLOW(dup2), ALLOW(dup3), ALLOW(pipe), ALLOW(pipe2),
    ALLOW(poll), ALLOW(ppoll), ALLOW(select), ALLOW(pselect6), ALLOW(epoll_create1), ALLOW(epoll_ctl), ALLOW(epoll_wait), ALLOW(epoll_pwait),
    ALLOW(eventfd2), ALLOW(execve), ALLOW(fork), ALLOW(vfork), ALLOW(wait4), ALLOW(waitid),
    ALLOW(kill), ALLOW(tgkill), ALLOW(tkill), ALLOW(setsid), ALLOW(setpgid), ALLOW(getpgid), ALLOW(getpgrp),
    ALLOW(exit), ALLOW(exit_group),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
  };
  struct sock_fprog program = { .len = sizeof(code) / sizeof(code[0]), .filter = code };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail();
}
static void drop_privileges(struct limits l) {
  struct rlimit core = {0, 0}, descriptors = {64, 64};
  struct rlimit files = {(rlim_t)l.temporary, (rlim_t)l.temporary};
  struct rlimit cpu = {(rlim_t)((l.cpu + 999) / 1000 + 1), (rlim_t)((l.cpu + 999) / 1000 + 1)};
  if (setrlimit(RLIMIT_CORE, &core) || setrlimit(RLIMIT_NOFILE, &descriptors) || setrlimit(RLIMIT_FSIZE, &files) || setrlimit(RLIMIT_CPU, &cpu)) fail();
  if (prctl(PR_SET_SECUREBITS, SECBIT_NOROOT | SECBIT_NOROOT_LOCKED | SECBIT_NO_SETUID_FIXUP | SECBIT_NO_SETUID_FIXUP_LOCKED)) fail();
  for (int cap = 0; cap <= CAP_LAST_CAP; cap++) if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)) fail();
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2] = {{0}, {0}};
  if (syscall(SYS_capset, &header, &data) || prctl(PR_SET_DUMPABLE, 0) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail();
  seccomp_policy();
}
static void bind_readonly(const char *source, const char *target, int executable) {
  unsigned long flags = MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV | (executable ? 0 : MS_NOEXEC);
  if (mount(source, target, NULL, MS_BIND, NULL) || mount(NULL, target, NULL, flags, NULL)) fail();
}
static void new_root(const char *staging, struct limits l, int inputs) {
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) fail();
  bind_readonly("/proc/self/fd/4", staging, 1);
  char target[256], size[128];
  snprintf(target, sizeof(target), "%s/input", staging);
  if (inputs) bind_readonly("/proc/self/fd/5", target, 0);
  snprintf(target, sizeof(target), "%s/work", staging);
  snprintf(size, sizeof(size), "size=%ld,nr_inodes=256,mode=0700", l.temporary);
  if (mount("tmpfs", target, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, size) || chdir(target) || mkdir("out", 0700) || mkdir("tmp", 0700)) fail();
  snprintf(target, sizeof(target), "%s/tmp", staging);
  if (mount("tmp", target, NULL, MS_BIND, NULL)) fail();
  snprintf(target, sizeof(target), "%s/proc", staging);
  if (mount("proc", target, "proc", MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, "hidepid=2,subset=pid")) fail();
  if (chdir(staging) || syscall(SYS_pivot_root, ".", "old") || chdir("/") || umount2("/old", MNT_DETACH) || chdir("/work")) fail();
  close(3); close(4); close(5); if (cg >= 0) close(cg); if (cgparent >= 0) close(cgparent);
  if (clearenv() || setenv("PATH", "/usr/bin", 1) || setenv("LANG", "C", 1) || setenv("HOME", "/work", 1)
    || setenv("TMPDIR", "/work/tmp", 1) || setenv("UV_THREADPOOL_SIZE", "1", 1)) fail();
  umask(0077);
}
static int safe_name(const char *name) {
  size_t n = strlen(name); if (!n || n > 120 || !strcmp(name, ".") || !strcmp(name, "..")) return 0;
  for (size_t i = 0; i < n; i++) if (!(name[i] >= 'a' && name[i] <= 'z') && !(name[i] >= 'A' && name[i] <= 'Z')
    && !(name[i] >= '0' && name[i] <= '9') && name[i] != '.' && name[i] != '_' && name[i] != '-') return 0;
  return 1;
}
static int export_files(int receipt, long budget) {
  int fd = open("/work/out", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1; DIR *directory = fdopendir(fd); if (!directory) { close(fd); return -1; }
  struct dirent *entry; int count = 0, result = 0; long bytes = 0;
  while ((entry = readdir(directory))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (!safe_name(entry->d_name) || ++count > MAX_FILES) { result = -1; break; }
    int file = openat(fd, entry->d_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC); struct stat st;
    if (file < 0) { result = -1; break; }
    if (fstat(file, &st) || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_size < 0 || st.st_size > budget - bytes) { close(file); result = -1; break; }
    bytes += st.st_size;
    if (write_all(receipt, "F ", 2) || write_all(receipt, entry->d_name, strlen(entry->d_name)) || write_all(receipt, " ", 1)) { close(file); result = -1; break; }
    char raw[1024], hex[2048]; ssize_t n;
    while ((n = read(file, raw, sizeof(raw))) > 0) {
      for (ssize_t i = 0; i < n; i++) { hex[i * 2] = "0123456789abcdef"[(unsigned char)raw[i] >> 4]; hex[i * 2 + 1] = "0123456789abcdef"[(unsigned char)raw[i] & 15]; }
      if (write_all(receipt, hex, (size_t)n * 2)) { result = -1; break; }
    }
    if (n < 0 || write_all(receipt, "\n", 1)) result = -1;
    close(file); if (result) break;
  }
  closedir(directory); return result;
}
static int denied(long result) { return result == -1 && (errno == EPERM || errno == EACCES); }
static void fixed_test(int test, struct limits l) {
  if (test == 1) {
    if (getpid() != 2 || getppid() != 1 || getenv("NODE_OPTIONS") || getenv("LD_PRELOAD") || getenv("MISAKA_BOT_TOKEN")) fail();
    for (int fd = 3; fd < 64; fd++) if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) fail();
    for (int fd = 0; fd < 3; fd++) { struct stat st; if (fstat(fd, &st) || !S_ISFIFO(st.st_mode)) fail(); }
    struct statfs work, temporary;
    if (statfs("/work", &work) || statfs("/tmp", &temporary) || work.f_type != TMPFS_MAGIC || temporary.f_type != TMPFS_MAGIC
      || (unsigned long)work.f_blocks * work.f_bsize > (unsigned long)l.temporary || work.f_files > 256) fail();
    char status[8192];
    if (text_at(AT_FDCWD, "/proc/self/status", status, sizeof(status)) || !strstr(status, "CapEff:\t0000000000000000")
      || !strstr(status, "CapBnd:\t0000000000000000") || !strstr(status, "NoNewPrivs:\t1") || !strstr(status, "Seccomp:\t2")) fail();
    const char *absent[] = {"/home", "/data", "/etc", "/sys", "/dev", "/old/home", "/proc/1/root/home", "/proc/3", NULL};
    for (int i = 0; absent[i]; i++) if (access(absent[i], F_OK) == 0) fail();
    int private_fd = open("/proc/1/fd/6", O_WRONLY);
    if (private_fd != -1 || (errno != EPERM && errno != EACCES && errno != ENOENT)) fail();
    int fd = open("/usr/bin/node", O_WRONLY); if (fd >= 0 || errno != EROFS) fail();
    if (!denied(socket(AF_INET, SOCK_STREAM, 0)) || !denied(socket(AF_INET6, SOCK_STREAM, 0)) || !denied(socket(AF_UNIX, SOCK_STREAM, 0))) fail();
    if (!denied(syscall(SYS_unshare, CLONE_NEWUSER)) || !denied(syscall(SYS_setns, -1, 0))
      || !denied(syscall(SYS_mount, "none", "/", "tmpfs", 0, NULL)) || !denied(syscall(SYS_ptrace, 0, 0, 0, 0))
      || !denied(syscall(SYS_bpf, 0, NULL, 0)) || !denied(syscall(SYS_io_uring_setup, 0, NULL))
      || !denied(syscall(SYS_userfaultfd, 0)) || !denied(syscall(SYS_keyctl, 0, 0, 0, 0, 0))
      || !denied(syscall(SYS_clone, CLONE_NEWUSER | SIGCHLD, 0, 0, 0, 0))) fail();
    _exit(0);
  }
  if (test == 2) { /* Bounded fork pressure; cgroup, not RLIMIT_NPROC. */
    for (int n = 0; n < 24; n++) { pid_t p = fork(); if (p < 0) _exit(errno == EAGAIN ? 0 : 125); if (!p) for (;;) sleep(1); }
    fail();
  }
  if (test == 3) { /* Touch a bounded 80 MiB, never an unbounded host allocation. */
    for (int n = 0; n < 80; n++) { volatile char *p = mmap(NULL, 1048576, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
      if (p == MAP_FAILED) fail(); for (long i = 0; i < 1048576; i += 4096) p[i] = 1; }
    fail();
  }
  if (test == 4) {
    /* The leader is idle. Both descendants must consume CPU before the cgroup
     * aggregate threshold (well below any per-process RLIMIT_CPU) ends the job. */
    for (int n = 0; n < 2; n++) {
      pid_t p = fork(); if (p < 0) fail();
      if (!p) {
        struct timespec used; int reported = 0; long end = milliseconds() + 12000;
        while (milliseconds() < end) {
          if (clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &used)) fail();
          if (!reported && used.tv_sec * 1000L + used.tv_nsec / 1000000L >= 60) {
            if (write_all(1, "c", 1)) fail(); reported = 1;
          }
        }
        fail();
      }
    }
    for (;;) sleep(1);
  }
  if (test == 5) { signal(SIGXFSZ, SIG_IGN); char block[4096] = {0}; int fd = open("/work/tmp/full", O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0) fail(); for (long n = 0; n < l.temporary + 4096; n += sizeof(block)) if (write(fd, block, sizeof(block)) < 0) _exit(errno == ENOSPC || errno == EFBIG ? 0 : 125); fail(); }
  if (test == 6) { char data[4096] = {0}; for (int n = 0; n < 32; n++) if (write_all(1, data, sizeof(data))) break; fail(); }
  if (test == 7) { if (symlink("/usr/bin/node", "/work/out/escape")) fail(); _exit(0); }
  if (test == 8) { if (setsid() < 0) fail(); pid_t p = fork(); if (p < 0) fail(); if (!p) for (;;) sleep(1); _exit(0); }
  if (test == 10) { if (setsid() < 0) fail(); pid_t p = fork(); if (p < 0) fail(); if (!p) for (;;) sleep(1);
    if (write_all(1, "cancel-ready", 12)) fail(); for (;;) sleep(1); }
  if (test >= 11 && test <= 13) for (;;) sleep(1);
  fail();
}
static void namespace_init(const char *staging, struct limits l, int test, char **args, int receipt) {
  new_root(staging, l, !test);
  /* Keep just the trusted receipt while PID 1 supervises. The executable child
   * closes it before installing the inherited filter or invoking Node. */
  if (receipt != 6) { if (dup2(receipt, 6) < 0) fail(); close(receipt); }
  if (syscall(SYS_close_range, 7U, ~0U, 0)) fail();
  drop_privileges(l);
  pid_t worker = fork(); if (worker < 0) fail();
  if (!worker) {
    close(6);
    if (test && test != 9) fixed_test(test, l);
    char *argv[MAX_ARGS + 10] = {"/usr/bin/node", "--jitless", "--no-expose-wasm", "--max-old-space-size=16", "--v8-pool-size=1", "--", NULL};
    char *smoke[] = {"/usr/lib/misaka/smoke.mjs", NULL};
    if (test == 9) args = smoke;
    int i = 0; while (args[i] && i < MAX_ARGS + 1) { argv[i + 6] = args[i]; i++; } argv[i + 6] = NULL;
    execve(argv[0], argv, environ); fail();
  }
  int status; while (waitpid(worker, &status, 0) < 0) if (errno != EINTR) fail();
  if (kill(-1, SIGKILL)) { if (errno != ESRCH) fail(); }
  int other; while (waitpid(-1, &other, 0) > 0 || errno == EINTR) { }
  if (errno != ECHILD) fail();
  int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  if ((!test || test == 7) && export_files(6, l.output)) _exit(124);
  _exit(code);
}
/* Parent-driven qualification cancellation uses a different signal so a real
 * caller SIGTERM is never cleared or mistaken for a successful self-test. */
static int request_test_cancel(int point) {
  if (dprintf(6, "TEST_CANCEL %d\n", point) < 0) return 4;
  long end = milliseconds() + 3000;
  while (!cancelled && !test_cancelled && milliseconds() < end) poll(NULL, 0, 10);
  if (cancelled) return 5;
  if (!test_cancelled) return 3;
  measured_cancel_point = point;
  return 5;
}
/* 0 completed; 1 output limit; 2 CPU; 3 wall; 4 setup/error; 5 signal cancellation. */
static int run_job(struct limits l, int test, char **args, int *exit_code) {
  measured_oom = 0; measured_pids = 0;
  measured_cpu_children = 0; measured_cancel_point = 0;
  *exit_code = 125;
  if (cancelled) return 5;
  char staging[] = "/tmp/misaka-local-XXXXXX";
  if (make_cgroup(l)) return 4;
  if (!mkdtemp(staging)) return 4;
  int out[2], err[2], receipt[2], input[2], admission[2];
  if (pipe2(out, O_CLOEXEC) || pipe2(err, O_CLOEXEC) || pipe2(receipt, O_CLOEXEC) || pipe2(input, O_CLOEXEC)
    || pipe2(admission, O_CLOEXEC)) { rmdir(staging); return 4; }
  pid_t supervisor = getpid();
  pid_t child = fork();
  if (child < 0) { rmdir(staging); return 4; }
  if (!child) {
    close(admission[1]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != supervisor) fail();
    /* No self-admission: before this byte the child cannot fork, unshare, or
     * execute. Only the parent can move its still-unreaped child into the group. */
    char admitted;
    if (read(admission[0], &admitted, 1) != 1 || admitted != 'g') fail();
    close(admission[0]);
    uid_t uid = getuid(); gid_t gid = getgid();
    if (unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWNET | CLONE_NEWCGROUP)) fail();
    int proc = open("/proc/self", O_DIRECTORY | O_CLOEXEC); char map[80];
    snprintf(map, sizeof(map), "0 %lu 1", (unsigned long)uid);
    if (proc < 0 || put_at(proc, "setgroups", "deny") || put_at(proc, "uid_map", map)) fail();
    snprintf(map, sizeof(map), "0 %lu 1", (unsigned long)gid);
    if (put_at(proc, "gid_map", map)) fail(); close(proc);
    if (sethostname("misaka-local", 12)) fail();
    if (dup2(input[0], 0) < 0 || dup2(out[1], 1) < 0 || dup2(err[1], 2) < 0) fail();
    /* PID 1 is the only process permitted to keep the result descriptor. */
    int ready[2], go[2];
    if (pipe2(ready, O_CLOEXEC) || pipe2(go, O_CLOEXEC)) fail();
    pid_t init = fork(); if (init < 0) fail();
    if (!init) {
      close(ready[0]); close(go[1]);
      /* PID 1 sees an outside-namespace parent as PID 0. A two-way handshake
       * closes the otherwise uncheckable PR_SET_PDEATHSIG registration race. */
      char byte;
      if (prctl(PR_SET_PDEATHSIG, SIGKILL) || write_all(ready[1], "r", 1) || read(go[0], &byte, 1) != 1 || byte != 'g') fail();
      close(ready[1]); close(go[0]);
      namespace_init(staging, l, test, args, receipt[1]);
    }
    close(ready[1]); close(go[0]); char byte;
    if (read(ready[0], &byte, 1) != 1 || byte != 'r' || write_all(go[1], "g", 1)) fail();
    syscall(SYS_close_range, 0U, ~0U, 0);
    int status; while (waitpid(init, &status, 0) < 0) if (errno != EINTR) fail();
    _exit(WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
  }
  close(admission[0]);
  close(out[1]); close(err[1]); close(receipt[1]); close(input[0]);
  int descriptors[] = {out[0], err[0], receipt[0], input[1]};
  for (size_t i = 0; i < sizeof(descriptors)/sizeof(descriptors[0]); i++) if (fcntl(descriptors[i], F_SETFL, O_NONBLOCK)) fail();
  char collected[MAX_OUTPUT + 4096]; size_t collected_len = 0;
  long total = 0, input_total = 0, start = milliseconds(); int result = 0, status = 0, finished = 0, child_done = 0;
  int eof[3] = {0, 0, 0};
  char member[64], membership[128], ready_marker[12]; size_t ready_length = 0;
  if (test == 11) result = request_test_cancel(11);
  if (!result && cancelled) result = 5;
  if (!result) {
    snprintf(member, sizeof(member), "%ld", (long)child);
    if (put_at(cg, "cgroup.procs", member) || text_at(cg, "cgroup.procs", membership, sizeof(membership))) result = 4;
    else {
      size_t length = strlen(member); member[length] = '\n'; member[length + 1] = 0;
      if (strcmp(member, membership)) result = 4;
    }
  }
  if (!result && test == 12) result = request_test_cancel(12);
  if (!result && cancelled) result = 5;
  if (!result && write_all(admission[1], "g", 1)) result = 4;
  close(admission[1]);
  if (!result && test == 13) result = request_test_cancel(13);
  while (!result && !finished) {
    long used = cpu_used();
    if (used < 0) { result = 4; break; }
    if (used > l.cpu) { result = 2; break; }
    if (cancelled || test_cancelled) { result = 5; break; }
    if (milliseconds() - start > l.wall) { result = 3; break; }
    struct pollfd fds[] = {{eof[0] ? -1 : out[0], POLLIN, 0}, {eof[1] ? -1 : err[0], POLLIN, 0}, {eof[2] ? -1 : receipt[0], POLLIN, 0}, {test || input[1] < 0 ? -1 : 0, POLLIN, 0}};
    if (poll(fds, 4, 10) < 0 && errno != EINTR) { result = 4; break; }
    for (int i = 0; i < 3; i++) {
      if (eof[i]) continue;
      char block[4096]; ssize_t n;
      while ((n = read(fds[i].fd, block, sizeof(block))) > 0) {
        total += n;
        if (test == 4 && i == 0) {
          for (ssize_t k = 0; k < n; k++) { if (block[k] != 'c') { result = 4; break; } measured_cpu_children++; }
          if (result || measured_cpu_children > 2) { result = 4; break; }
        }
        if (test == 10 && i == 0) {
          if (ready_length + (size_t)n > sizeof(ready_marker)) { result = 4; break; }
          memcpy(ready_marker + ready_length, block, (size_t)n); ready_length += (size_t)n;
          if (ready_length == sizeof(ready_marker)) {
            if (memcmp(ready_marker, "cancel-ready", sizeof(ready_marker))) result = 4;
            else result = request_test_cancel(10);
            break;
          }
        }
        if (total > l.output || (i == 2 && collected_len + (size_t)n > sizeof(collected))) { result = 1; break; }
        if (i == 2) { memcpy(collected + collected_len, block, (size_t)n); collected_len += (size_t)n; }
        else if (!test && write_all(i + 1, block, (size_t)n)) { result = 1; break; }
      }
      if (!n) eof[i] = 1;
      else if (n < 0 && errno != EAGAIN && errno != EINTR) result = 4;
      if (result) break;
    }
    if (result) break;
    if (!test && (fds[3].revents & (POLLIN | POLLHUP))) {
      char block[4096]; ssize_t n = read(0, block, sizeof(block));
      if (n > 0) { input_total += n; if (input_total > MAX_OUTPUT || write_all(input[1], block, (size_t)n)) { result = 1; break; } }
      else if (!n) { close(input[1]); input[1] = -1; }
    }
    if (!child_done) {
      pid_t done = waitpid(child, &status, WNOHANG);
      if (done == child) child_done = 1; else if (done < 0 && errno != EINTR) { result = 4; break; }
    }
    finished = child_done && eof[0] && eof[1] && eof[2];
  }
  *exit_code = finished ? (WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status)) : 125;
  char events[1024];
  if (!text_at(cg, "memory.events", events, sizeof(events))) {
    char *value = strstr(events, "\noom_kill "); if (value) sscanf(value, "\noom_kill %lu", &measured_oom);
  }
  if (!text_at(cg, "pids.events", events, sizeof(events))) sscanf(events, "max %lu", &measured_pids);
  /* Seal the admission race BEFORE observing an empty cgroup. The PID cannot
   * be reused until reaped; even a never-scheduled, pre-admission child is killed
   * and awaited here. All descendants of an admitted child already belong to cg. */
  if (!child_done) {
    if (kill(child, SIGKILL) && errno != ESRCH) fail();
    while (waitpid(child, &status, 0) < 0) if (errno != EINTR) fail();
  }
  /* On EVERY outcome: kill delegated tree, observe empty, then reap adopted
   * descendants, then remove the cgroup. No process-group-only cancellation. */
  if (destroy_cgroup()) { dprintf(6, "ERR CLEANUP_UNVERIFIED %d\n", errno); for (;;) pause(); }
  close(out[0]); close(err[0]); close(receipt[0]); if (input[1] >= 0) close(input[1]);
  if (rmdir(staging)) result = 4;
  if (!test && !result && *exit_code != 124 && *exit_code != 125 && write_all(6, collected, collected_len)) result = 4;
  return result;
}
static int qualify(void) {
  struct limits l = {67108864, 1000, 16, 65536, 4194304, 15000}; int exit_code;
  for (int test = 1; test <= 13; test++) {
    struct limits t = l; if (test == 4) t.cpu = 300; if (test == 6) t.output = 4096;
    int result = run_job(t, test, NULL, &exit_code);
    int success = test == 3 ? (result == 0 && exit_code == 137 && measured_oom > 0)
      : test == 2 ? (result == 0 && exit_code == 0 && measured_pids > 0)
      : test == 4 ? (result == 2 && measured_cpu_children == 2) : test == 6 ? result == 1 : test == 7 ? (result == 0 && exit_code == 124)
      : test >= 10 ? (result == 5 && test_cancelled && measured_cancel_point == test && !cancelled)
      : result == 0 && exit_code == 0;
    if (!success) { dprintf(6, "ERR QUALIFICATION_%d %d\n", test, errno); return -1; }
    test_cancelled = 0;
  }
  return 0;
}
static long number(const char *s, long ceiling) {
  if (!s || !*s) fail(); char *end; errno = 0; long n = strtol(s, &end, 10);
  if (errno || *end || n < 1 || n > ceiling) fail(); return n;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--policy")) { puts(POLICY_SHA256); return 0; }
  if (argc < 2 || (strcmp(argv[1], "--probe") && strcmp(argv[1], "--run"))) return 125;
  int probe = !strcmp(argv[1], "--probe");
  if ((probe && argc != 2) || (!probe && (argc < 9 || argc > 9 + MAX_ARGS))) return 125;
  if (geteuid() != getuid() || getegid() != getgid() || geteuid() == 0) return 125;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return 125;
  signal(SIGPIPE, SIG_IGN); signal(SIGTERM, cancel_handler); signal(SIGINT, cancel_handler);
  signal(SIGUSR2, test_cancel_handler);
  if (prctl(PR_SET_PDEATHSIG, SIGTERM) || getppid() == 1) return 125;
  for (int i = 0; i <= 6; i++) if (i != 3 && i != 4 && i != 5 && fcntl(i, F_SETFL, O_NONBLOCK)) return 125;
  if (syscall(SYS_close_range, 7U, ~0U, 0)) return 125;
  if (clearenv()) return 125;
  if (qualify()) { if (cg >= 0 || cgparent >= 0) if (destroy_cgroup()) for (;;) pause(); return 125; }
  if (probe) { dprintf(6, "QUALIFIED %s\n", POLICY_SHA256); return 0; }
  struct limits l = {number(argv[2], 67108864), number(argv[3], 5000), number(argv[4], 16), number(argv[5], 65536), number(argv[6], 4194304), number(argv[7], 15000)};
  if (l.temporary % 4096) return 125;
  if (strncmp(argv[8], "/input/", 7) || strstr(argv[8], "/../") || strstr(argv[8], "/./")) return 125;
  int code; int result = run_job(l, 0, argv + 8, &code);
  if (cg >= 0 || cgparent >= 0) if (destroy_cgroup()) for (;;) pause();
  if (result || code == 124 || code == 125) { dprintf(6, "ERR RUN_%d %d\n", result ? result : code, errno); return 125; }
  dprintf(6, "OK %d\n", code); return 0;
}

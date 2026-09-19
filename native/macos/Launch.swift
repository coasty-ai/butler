import Foundation

/**
 coarena-launch: starts a server the user added as a process of its own.

   coarena-launch [--no-network] -- <absolute command> [args…]

 A child spawned plainly from the app inherits every grant the app holds
 (Screen Recording, Accessibility, Automation, Full Disk Access when texting is
 on) through TCC's responsible-process rule. This shim posix_spawns the command
 with responsibility disclaimed, so macOS treats the server as itself and asks
 about its own access under its own name. `--no-network` runs the command under
 sandbox-exec with a profile that denies outbound IP and the DNS socket while
 stdio keeps working, for servers declared local (docs/TOOLS.md, plan §2.6.3).

 stdin, stdout and stderr pass straight through; SIGTERM, SIGINT and SIGHUP are
 forwarded; the exit status is the child's. The shim's own refusals are the only
 lines it ever writes, one code name on stderr, before any child starts:

   64 LAUNCH_BAD_COMMAND   no "--", an unknown flag, a relative or non-executable command, or the spawn failed
   69 LAUNCH_NO_SANDBOX    --no-network asked for but sandbox-exec is not on this Mac
   70 LAUNCH_NO_DISCLAIM   the disclaim call is not available
 */

// The SPI behind Electron's utilityProcess `disclaim` option, in libSystem since 10.14.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
private func responsibility_spawnattrs_setdisclaim(_ attributes: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

#if LAUNCH_TEST_NO_SANDBOX_EXEC
// Built only by tests/native/LaunchTests.swift to see the 69 path on a Mac that has sandbox-exec.
let sandboxExecPath = "/usr/bin/sandbox-exec-not-installed"
#else
let sandboxExecPath = "/usr/bin/sandbox-exec"
#endif
let sandboxProfile = "(version 1)(allow default)(deny network-outbound (remote ip))"
    + "(deny network-outbound (remote unix-socket (path-literal \"/private/var/run/mDNSResponder\")))"

/// The child, for the signal handlers (a C handler cannot capture).
private var childPid: pid_t = 0

@main struct LaunchMain {
    static func refuse(_ code: Int32, _ name: String) -> Never {
        FileHandle.standardError.write((name + "\n").data(using: .utf8)!)
        exit(code)
    }

    static func main() {
        var arguments = Array(CommandLine.arguments.dropFirst())
        var noNetwork = false
        var separated = false
        while let flag = arguments.first {
            arguments.removeFirst()
            if flag == "--" { separated = true; break }
            guard flag == "--no-network" else { refuse(64, "LAUNCH_BAD_COMMAND") }
            noNetwork = true
        }
        guard separated, let command = arguments.first, command.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: command) else { refuse(64, "LAUNCH_BAD_COMMAND") }
        var argv = arguments
        if noNetwork {
            guard FileManager.default.isExecutableFile(atPath: sandboxExecPath) else { refuse(69, "LAUNCH_NO_SANDBOX") }
            argv = [sandboxExecPath, "-p", sandboxProfile] + argv
        }

        var attributes: posix_spawnattr_t? = nil
        guard posix_spawnattr_init(&attributes) == 0, responsibility_spawnattrs_setdisclaim(&attributes, 1) == 0 else {
            refuse(70, "LAUNCH_NO_DISCLAIM")
        }
        defer { posix_spawnattr_destroy(&attributes) }

        let cArguments = argv.map { strdup($0) } + [nil]
        defer { for pointer in cArguments { free(pointer) } }
        var pid: pid_t = 0
        guard posix_spawn(&pid, argv[0], nil, &attributes, cArguments, environ) == 0 else { refuse(64, "LAUNCH_BAD_COMMAND") }
        childPid = pid
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig) { received in kill(childPid, received) }
        }

        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 {
            guard errno == EINTR else { exit(1) }
        }
        // WIFEXITED / WEXITSTATUS / WTERMSIG, which Swift does not import.
        if status & 0x7f == 0 { exit((status >> 8) & 0xff) }
        exit(128 + (status & 0x7f))
    }
}

import Foundation

// coarena-launch as a process: argv rules, pass-through and the network
// sandbox. scripts/test-native-safety.mjs builds the shim twice and names the
// binaries in COARENA_LAUNCH and COARENA_LAUNCH_NO_SANDBOX (the latter told at
// compile time that sandbox-exec is missing). Whether macOS honours the
// disclaim is a live check (Gate 0), not a test.
func launchChecks(_ check: (Bool, String) -> Void) {
    let environment = ProcessInfo.processInfo.environment
    guard let shim = environment["COARENA_LAUNCH"], let noSandbox = environment["COARENA_LAUNCH_NO_SANDBOX"] else {
        check(false, "COARENA_LAUNCH and COARENA_LAUNCH_NO_SANDBOX name the built shims")
        return
    }
    struct Outcome { let status: Int32; let stdout: String; let stderr: String }
    func run(_ binary: String, _ arguments: [String], stdin input: String? = nil) -> Outcome {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = arguments
        let out = Pipe(), err = Pipe(), inPipe = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = inPipe
        try! process.run()
        if let input { inPipe.fileHandleForWriting.write(input.data(using: .utf8)!) }
        try? inPipe.fileHandleForWriting.close()
        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        process.waitUntilExit()
        return Outcome(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }

    // Argv rules: 64 and one code name on stderr, before anything runs.
    for (arguments, name) in [
        (["--", "bin/sh", "-c", "echo x"], "a relative command"),
        (["--", "/etc/hosts"], "a non-executable command"),
        (["--", "/nonexistent/binary"], "a missing command"),
        (["/bin/echo", "x"], "a command without the -- separator"),
        (["--verbose", "--", "/bin/echo", "x"], "an unknown flag"),
        (["--"], "no command at all"),
        ([], "no arguments at all"),
    ] {
        let outcome = run(shim, arguments)
        check(outcome.status == 64 && outcome.stderr == "LAUNCH_BAD_COMMAND\n" && outcome.stdout.isEmpty, "\(name) exits 64 LAUNCH_BAD_COMMAND")
    }

    // Pass-through: stdout, stdin, exit status, a signal.
    let echo = run(shim, ["--", "/bin/echo", "hello"])
    check(echo.status == 0 && echo.stdout == "hello\n" && echo.stderr.isEmpty, "stdout passes through and the shim writes nothing")
    let cat = run(shim, ["--", "/bin/cat"], stdin: "ping\n")
    check(cat.status == 0 && cat.stdout == "ping\n", "stdin passes through")
    check(run(shim, ["--", "/bin/sh", "-c", "exit 7"]).status == 7, "the child's exit status is the shim's")
    check(run(shim, ["--", "/bin/sh", "-c", "echo err 1>&2; exit 0"]).stderr == "err\n", "the child's stderr passes through")
    check(run(shim, ["--", "/bin/sh", "-c", "kill -TERM $$"]).status == 143, "a child killed by a signal exits 128 plus the signal")

    // --no-network: stdio works while outbound IP and DNS are denied.
    let sandboxed = run(shim, ["--no-network", "--", "/bin/sh", "-c", "echo inside; curl -s --max-time 5 https://example.com > /dev/null; echo curl=$?"])
    check(sandboxed.status == 0 && sandboxed.stdout.hasPrefix("inside\n"), "a sandboxed child's stdout line is received")
    check(sandboxed.stdout.contains("curl=") && !sandboxed.stdout.contains("curl=0"), "a sandboxed child's curl to the internet fails")
    let loopback = run(shim, ["--no-network", "--", "/bin/sh", "-c", "curl -s --max-time 2 http://127.0.0.1:9/ > /dev/null; echo curl=$?"])
    check(!loopback.stdout.contains("curl=0"), "a sandboxed child cannot reach loopback either")
    // Missing sandbox-exec: 69, and the command never runs.
    let missing = run(noSandbox, ["--no-network", "--", "/bin/echo", "ran"])
    check(missing.status == 69 && missing.stderr == "LAUNCH_NO_SANDBOX\n" && missing.stdout.isEmpty, "--no-network without sandbox-exec exits 69 LAUNCH_NO_SANDBOX")
    check(run(noSandbox, ["--", "/bin/echo", "ran"]).stdout == "ran\n", "without --no-network the same shim still launches")
}

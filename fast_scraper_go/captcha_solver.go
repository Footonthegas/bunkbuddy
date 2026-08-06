package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	captchaTimeout = 30 * time.Second
)

func solveCaptchaGo(captchaBytes []byte) string {
	scriptPath := findCaptchaSolverScript()
	if scriptPath == "" {
		return ""
	}

	var cmd *exec.Cmd
	if strings.HasSuffix(scriptPath, ".js") {
		nodeBin := findNodeBinary()
		if nodeBin == "" {
			return ""
		}
		cmd = exec.Command(nodeBin, scriptPath)
	} else {
		pythonBin := findPythonBinary()
		if pythonBin == "" {
			return ""
		}
		cmd = exec.Command(pythonBin, scriptPath)
	}

	cmd.Stdin = bytes.NewReader(captchaBytes)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	done := make(chan error, 1)
	go func() {
		done <- cmd.Run()
	}()

	select {
	case <-time.After(captchaTimeout):
		_ = cmd.Process.Kill()
		return ""
	case err := <-done:
		if err != nil {
			return ""
		}
	}

	result := strings.TrimSpace(stdout.String())
	return result
}

func findCaptchaSolverScript() string {
	if p := os.Getenv("CAPTCHA_SOLVER_SCRIPT"); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}

	jsCandidates := []string{
		"solve_captcha.js",
		"../solve_captcha.js",
		"../../solve_captcha.js",
	}
	pyCandidates := []string{
		"solve_captcha_cli.py",
		"../solve_captcha_cli.py",
		"../../solve_captcha_cli.py",
	}

	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		jsCandidates = append(jsCandidates,
			filepath.Join(exeDir, "solve_captcha.js"),
			filepath.Join(exeDir, "..", "solve_captcha.js"),
		)
		pyCandidates = append(pyCandidates,
			filepath.Join(exeDir, "solve_captcha_cli.py"),
			filepath.Join(exeDir, "..", "solve_captcha_cli.py"),
		)
	}

	wd, err := os.Getwd()
	if err == nil {
		jsCandidates = append(jsCandidates,
			filepath.Join(wd, "solve_captcha.js"),
			filepath.Join(wd, "..", "solve_captcha.js"),
		)
		pyCandidates = append(pyCandidates,
			filepath.Join(wd, "solve_captcha_cli.py"),
			filepath.Join(wd, "..", "solve_captcha_cli.py"),
		)
	}

	allCandidates := append(jsCandidates, pyCandidates...)
	for _, c := range allCandidates {
		abs, _ := filepath.Abs(c)
		if _, err := os.Stat(abs); err == nil {
			return abs
		}
	}

	return ""
}

func findNodeBinary() string {
	for _, name := range []string{"node", "nodejs"} {
		if p, err := exec.LookPath(name); err == nil && p != "" {
			return p
		}
	}
	return ""
}

func findPythonBinary() string {
	if venv := os.Getenv("VIRTUAL_ENV"); venv != "" {
		py := filepath.Join(venv, "Scripts", "python.exe")
		if runtime.GOOS == "linux" || runtime.GOOS == "darwin" {
			py = filepath.Join(venv, "bin", "python3")
		}
		if _, err := os.Stat(py); err == nil {
			return py
		}
	}

	scriptDir := ""
	if exe, err := os.Executable(); err == nil {
		scriptDir = filepath.Dir(exe)
	}
	wd, err := os.Getwd()
	if err == nil {
		for _, base := range []string{wd, scriptDir} {
			for _, rel := range []string{"", ".."} {
				venvPath := filepath.Join(base, rel, ".venv")
				if _, err := os.Stat(venvPath); err == nil {
					py := filepath.Join(venvPath, "Scripts", "python.exe")
					if runtime.GOOS == "linux" || runtime.GOOS == "darwin" {
						py = filepath.Join(venvPath, "bin", "python3")
					}
					if _, err := os.Stat(py); err == nil {
						return py
					}
				}
			}
		}
	}

	for _, name := range []string{"python3", "python"} {
		if p, err := exec.LookPath(name); err == nil && p != "" {
			return p
		}
	}
	return ""
}

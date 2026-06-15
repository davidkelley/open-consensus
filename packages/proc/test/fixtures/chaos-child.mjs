// Test fixture: a deliberately badly-behaved child process for exercising the
// hardened runner (plan D10/Stage 3). It is a local node stub — NOT a real
// agent CLI — so it spawns no network calls and costs nothing.
//
// Usage: node chaos-child.mjs <mode> [arg]
//   echo      read stdin, write it back, exit 0
//   ansi      emit ANSI colour + bell + control chars, exit 0
//   flood     write ~4MB of output (tests the byte cap / overflow)
//   exit N    exit with code N
//   sleep     sleep ~60s (tests timeout / cancellation)
//   stubborn  ignore SIGTERM, spawn a sleeping grandchild, print its pid, sleep
import { spawn } from 'node:child_process'

const mode = process.argv[2] ?? 'echo'
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

function sleepForever() {
  setTimeout(() => process.exit(0), 60_000)
}

switch (mode) {
  case 'echo': {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => {
      data += d
    })
    process.stdin.on('end', () => {
      process.stdout.write(data)
      process.exit(0)
    })
    break
  }
  case 'ansi': {
    process.stdout.write(`${ESC}[31mred${ESC}[0m${BEL} plain text\n`)
    process.exit(0)
    break
  }
  case 'flood': {
    const chunk = 'x'.repeat(64 * 1024)
    let n = 0
    const pump = () => {
      if (n++ >= 64) {
        process.exit(0)
        return
      }
      process.stdout.write(chunk, () => setTimeout(pump, 0))
    }
    pump()
    break
  }
  case 'exit': {
    process.exit(Number(process.argv[3] ?? 0))
    break
  }
  case 'sleep': {
    sleepForever()
    break
  }
  case 'stubborn': {
    process.on('SIGTERM', () => {
      /* refuse to die on SIGTERM — forces the SIGKILL escalation path */
    })
    const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    })
    process.stdout.write(`grandchild:${grandchild.pid}\n`)
    sleepForever()
    break
  }
  default:
    process.exit(0)
}

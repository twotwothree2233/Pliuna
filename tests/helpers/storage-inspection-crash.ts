import { inspectStorage } from '../../src/runtime/storage-inspection'
void inspectStorage(process.argv[2]!, { scope: 'resources' }, progress => {
  if (progress.phase === 'hashing') {
    process.send?.({ boundary: 'hashing' })
    // Hold only this disposable test process at a real streaming boundary.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
})

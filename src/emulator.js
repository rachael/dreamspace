// Desktop emulator: when no real headset is present, emulate a Meta Quest 3 with Meta's IWER + DevUI
// so Enter VR / Enter AR work on the laptop. On a real Quest or PICO this does nothing.
// Add ?noemu to the URL to turn it off.
const real = await navigator.xr?.isSessionSupported('immersive-vr').catch(() => false);
if (!real && !new URLSearchParams(location.search).has('noemu')) {
  try {
    const { XRDevice, metaQuest3 } = await import('https://esm.sh/iwer@2.5.0');
    const xrDevice = new XRDevice(metaQuest3);
    xrDevice.installRuntime({ forceInstall: true }); // Chrome has navigator.xr but no headset
    const { DevUI } = await import('https://esm.sh/@iwer/devui@2.5.0?deps=iwer@2.5.0'); // esm.sh: one shared React copy
    new DevUI(xrDevice);
  } catch (err) {
    console.warn('XR emulator failed to load; desktop stays flat', err);
  }
}

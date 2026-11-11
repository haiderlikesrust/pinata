import { useEffect, useMemo } from 'react';
import { connect } from './socket';
import { Stage } from './scene/Stage';
import { Hud } from './ui/Hud';
import { WinnersModal } from './ui/WinnersModal';
import { HistoryModal, HowModal } from './ui/Modals';
import { Floaters } from './ui/Floaters';
import { unlockAudio } from './audio';

function isLowPower() {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mobile = /Android|iPhone|iPad|iPod/i.test(nav.userAgent);
  const forced = new URLSearchParams(location.search).get('quality');
  if (forced === 'low') return true;
  if (forced === 'high') return false;
  return mobile || (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
}

export function App() {
  const low = useMemo(isLowPower, []);

  useEffect(() => connect(), []);
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  return (
    <div className="app">
      <Stage low={low} />
      <Floaters />
      <Hud />
      <WinnersModal />
      <HowModal />
      <HistoryModal />
    </div>
  );
}

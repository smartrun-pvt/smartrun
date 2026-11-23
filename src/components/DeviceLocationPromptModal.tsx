import React, { useState } from 'react';
import {
  X,
  MapPin,
  Search,
  Home,
  Briefcase,
  Building2,
  ChevronRight,
  Loader2,
  Check,
  Navigation
} from 'lucide-react';
import { KolkataArea, SavedAddress } from '../types';
import { KOLKATA_AREAS } from '../data/kolkataAreas';
import { ACTIVE_SAVED_ADDRESS_KEY, getActiveAddressStorageKey, safeSetItem, safeRemoveItem } from '../services/supabaseService';
import { useBottomSheetDismiss } from '../hooks/useBottomSheetDismiss';
import {
  getResilientCurrentPosition,
  resolveAreaFromCoordinates,
  reverseGeocodeWithFallback
} from '../utils/geolocationHelper';
import { showToast } from '../utils/toast';

interface DeviceLocationPromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  savedAddresses: SavedAddress[];
  currentArea: KolkataArea;
  activeAddress?: SavedAddress | null;
  onSelectArea: (area: KolkataArea, address?: SavedAddress) => void;
  onOpenManualSearch: () => void;
}

export const DeviceLocationPromptModal = ({
  isOpen,
  onClose,
  savedAddresses,
  activeAddress,
  onSelectArea,
  onOpenManualSearch
}: DeviceLocationPromptModalProps) => {
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  // Drag down to dismiss on mobile
  const {
    handleTouchStart: handleSheetTouchStart,
    handleTouchMove: handleSheetTouchMove,
    handleTouchEnd: handleSheetTouchEnd,
    dragStyle
  } = useBottomSheetDismiss({
    onClose,
    disabled: !isOpen
  });

  if (!isOpen) return null;

  const handleEnableLocation = async () => {
    setGpsLoading(true);
    setGpsError(null);

    try {
      // Multi-tier resilient positioning: triggers Android/browser runtime permission ONLY on Enable tap
      const pos = await getResilientCurrentPosition();
      const lat = pos.lat;
      const lng = pos.lng;

      // Safe reverse geocoding: primary Google Maps provider with Nominatim fallback
      let street = '';
      let pincode = '';
      try {
        const { mapManager } = await import('../services/maps');
        const revRes = await mapManager.reverseGeocode({ lat, lng });
        street = revRes.street || revRes.formattedAddress || '';
        pincode = revRes.pincode && /^\d{6}$/.test(revRes.pincode) ? revRes.pincode : '';
      } catch {
        const fallback = await reverseGeocodeWithFallback(lat, lng, 3500);
        street = fallback.street;
        pincode = fallback.pincode || '';
      }

      const appliedArea: KolkataArea = resolveAreaFromCoordinates(lat, lng, street, pincode);

      setGpsLoading(false);

      try {
        safeRemoveItem(getActiveAddressStorageKey());
        safeRemoveItem(ACTIVE_SAVED_ADDRESS_KEY);
      } catch (e) {
        console.error(e);
      }

      showToast(`Location detected: ${appliedArea.exactStreet || appliedArea.name}`, 'success');
      onSelectArea(appliedArea, undefined);
      onClose();
    } catch (err: any) {
      setGpsLoading(false);
      console.warn('Resilient geolocation error:', err);

      if (err?.code === 1 || String(err?.message || '').toLowerCase().includes('denied')) {
        setGpsError(
          'Location access is denied. You can allow location in your device/app settings, or choose your delivery area below.'
        );
      } else {
        setGpsError(
          'Location timed out or GPS signal is weak indoors. You can pick an area below or search manually.'
        );
      }
    }
  };

  const handleSelectDefaultHub = () => {
    const central = KOLKATA_AREAS[0]; // Kasba / Kolkata Central hub
    try {
      safeRemoveItem(getActiveAddressStorageKey());
      safeRemoveItem(ACTIVE_SAVED_ADDRESS_KEY);
    } catch (e) {
      console.error(e);
    }
    onSelectArea(central, undefined);
    onClose();
  };

  const handleSelectAddress = (addr: SavedAddress) => {
    try {
      safeSetItem(getActiveAddressStorageKey(), JSON.stringify(addr));
      safeSetItem(ACTIVE_SAVED_ADDRESS_KEY, JSON.stringify(addr));
    } catch (e) {
      console.error(e);
    }

    onSelectArea(addr.area, addr);
    onClose();
  };

  const getTagIcon = (tag: SavedAddress['tag']) => {
    switch (tag) {
      case 'home':
        return <Home className="w-4 h-4 text-rose-600" />;
      case 'work':
        return <Briefcase className="w-4 h-4 text-amber-600" />;
      case 'hotel':
        return <Building2 className="w-4 h-4 text-indigo-600" />;
      default:
        return <MapPin className="w-4 h-4 text-rose-600" />;
    }
  };

  const getTagTitle = (addr: SavedAddress) => {
    if (addr.tag === 'home') return 'Home';
    if (addr.tag === 'work') return 'Work';
    if (addr.tag === 'hotel') return 'Hotel / Site';
    return addr.tagLabel || 'Saved Location';
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end items-center bg-black/65 backdrop-blur-[4px] transition-opacity animate-in fade-in duration-200 p-0 sm:p-4">
      {/* Backdrop click to dismiss */}
      <div
        className="absolute inset-0 -z-10 cursor-pointer"
        onClick={onClose}
        aria-label="Dismiss location prompt"
      />

      {/* Floating Circular Close Button */}
      <button
        type="button"
        onClick={onClose}
        className="mb-3 w-10 h-10 rounded-full bg-[#1e293b]/95 hover:bg-slate-950 text-white shadow-xl flex items-center justify-center transition-transform hover:scale-105 active:scale-95 cursor-pointer border border-white/15"
        title="Close"
        aria-label="Close location prompt"
      >
        <X className="w-4.5 h-4.5 stroke-[2.5]" />
      </button>

      {/* Bottom Sheet Container - Perfectly fitted for mobile phone screens */}
      <div
        id="device-location-prompt-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Choose delivery location"
        style={dragStyle}
        className="w-full max-w-lg bg-white rounded-t-[28px] sm:rounded-3xl shadow-2xl overflow-hidden border border-slate-200/80 animate-in slide-in-from-bottom duration-300 flex flex-col max-h-[85vh] sm:max-h-[80vh] text-slate-900"
      >
        {/* Drag Down Handle on Mobile */}
        <div
          onTouchStart={handleSheetTouchStart}
          onTouchMove={handleSheetTouchMove}
          onTouchEnd={handleSheetTouchEnd}
          className="w-full flex flex-col items-center justify-center pt-3 pb-1.5 sm:hidden cursor-grab active:cursor-grabbing touch-none select-none"
        >
          <div className="w-12 h-1.5 bg-slate-200 rounded-full hover:bg-slate-300 transition-colors" />
        </div>

        <div className="p-4 sm:p-5 space-y-3 sm:space-y-3.5 overflow-y-auto no-scrollbar pb-6 sm:pb-5">

          {/* Card 1: Current Location with Soft Pink Pin Circle & Enable Pill Button */}
          <div className="bg-white rounded-2xl px-3.5 py-3.5 border border-slate-200/80 shadow-[0_1px_4px_rgba(15,23,42,0.04)] flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {/* Soft Pink Circular Location Pin */}
              <div className="relative flex items-center justify-center w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-rose-50 border border-rose-100/80 flex-shrink-0">
                <svg
                  className="w-5 h-5 sm:w-5.5 sm:h-5.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M12 2C8.13401 2 5 5.13401 5 9C5 14.18 11.16 21.32 11.45 21.65C11.74 21.98 12.26 21.98 12.55 21.65C12.84 21.32 19 14.18 19 9C19 5.13401 15.866 2 12 2Z"
                    fill="#f43f5e"
                  />
                  <ellipse
                    cx="12"
                    cy="8.8"
                    rx="2.8"
                    ry="2.8"
                    fill="white"
                  />
                </svg>
              </div>

              <div className="min-w-0">
                <h3 className="text-[15px] sm:text-base font-black text-slate-900 tracking-tight leading-none truncate">
                  Current location
                </h3>
              </div>
            </div>

            {/* Enable Action Pill Button */}
            <button
              type="button"
              id="enable-device-location-btn"
              onClick={handleEnableLocation}
              disabled={gpsLoading}
              className="px-5 py-2 rounded-full bg-gradient-to-r from-[#ff244f] via-[#f43f5e] to-[#ff3b5c] hover:brightness-105 active:scale-95 text-white font-bold text-xs sm:text-sm tracking-tight shadow-[0_6px_16px_-4px_rgba(244,63,94,0.55)] transition-all cursor-pointer shrink-0 disabled:opacity-75 flex items-center gap-1.5 min-h-[38px]"
            >
              {gpsLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Enabling...</span>
                </>
              ) : (
                <span>Enable</span>
              )}
            </button>
          </div>

          {/* Card 2: Search location manually Bar */}
          <button
            type="button"
            id="search-location-manually-trigger"
            onClick={() => {
              onClose();
              onOpenManualSearch();
            }}
            className="w-full bg-white border border-slate-200/80 hover:border-slate-300 rounded-2xl px-3.5 py-3 transition-all shadow-[0_1px_4px_rgba(15,23,42,0.04)] hover:shadow-xs flex items-center justify-between text-left cursor-pointer group min-h-[54px]"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-full bg-rose-50 border border-rose-100/80 text-[#f43f5e] flex items-center justify-center shrink-0">
                <Search className="w-4.5 h-4.5 stroke-[2.25]" />
              </div>
              <span className="text-sm font-medium text-slate-800 group-hover:text-slate-950 truncate">
                Search location manually
              </span>
            </div>
            <ChevronRight className="w-4.5 h-4.5 text-slate-400 group-hover:text-slate-700 group-hover:translate-x-0.5 transition-transform shrink-0" />
          </button>

          {/* GPS Error message if permission denied or timed out */}
          {gpsError && (
            <div className="p-3 bg-amber-50 border border-amber-200/90 rounded-2xl text-amber-900 text-xs font-medium space-y-2">
              <p className="leading-relaxed">{gpsError}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleSelectDefaultHub}
                  className="px-2.5 py-1 bg-amber-200/80 hover:bg-amber-300 text-amber-900 rounded-lg text-[11px] font-bold transition-colors cursor-pointer flex items-center gap-1"
                >
                  <Navigation className="w-3 h-3" />
                  <span>Set Central Kolkata</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenManualSearch();
                  }}
                  className="px-2.5 py-1 bg-white hover:bg-slate-100 text-slate-800 border border-slate-200 rounded-lg text-[11px] font-bold transition-colors cursor-pointer flex items-center gap-1"
                >
                  <Search className="w-3 h-3" />
                  <span>Search Area</span>
                </button>
              </div>
            </div>
          )}

          {/* Card 3: Saved Addresses (Shown when logged in and saved addresses exist) */}
          {savedAddresses && savedAddresses.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between px-1">
                <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  Saved Addresses
                </h4>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenManualSearch();
                  }}
                  className="text-xs font-bold text-[#f43f5e] hover:text-[#e11d48] transition-colors cursor-pointer"
                >
                  Manage ({savedAddresses.length})
                </button>
              </div>

              <div className="bg-white rounded-2xl p-1.5 shadow-[0_1px_4px_rgba(15,23,42,0.04)] divide-y divide-slate-100 max-h-[210px] overflow-y-auto no-scrollbar border border-slate-200/80">
                {savedAddresses.map((addr) => {
                  const isSelected = activeAddress?.id === addr.id;
                  const shortAddress =
                    [addr.houseName, addr.buildingRoad, addr.area?.name]
                      .map((part) => (part || '').trim())
                      .filter(Boolean)
                      .join(', ') || 'Kolkata';
                  return (
                    <button
                      type="button"
                      key={addr.id}
                      onClick={() => handleSelectAddress(addr)}
                      className={`w-full p-2.5 sm:p-3 rounded-xl transition-all cursor-pointer flex items-center justify-between gap-3 text-left group ${
                        isSelected
                          ? 'bg-rose-50/70 font-medium'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-3 overflow-hidden min-w-0">
                        <div className="w-9 h-9 rounded-full bg-rose-50 border border-rose-100/80 flex items-center justify-center shrink-0">
                          {getTagIcon(addr.tag)}
                        </div>
                        <div className="overflow-hidden min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs sm:text-sm font-bold text-slate-900 truncate">
                              {getTagTitle(addr)}
                            </span>
                          </div>
                          <p className="text-[11px] sm:text-xs text-slate-500 truncate">
                            {shortAddress}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {isSelected ? (
                          <div className="w-5 h-5 rounded-full bg-[#f43f5e] text-white flex items-center justify-center shadow-xs">
                            <Check className="w-3 h-3 stroke-[3]" />
                          </div>
                        ) : (
                          <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-slate-900 group-hover:translate-x-0.5 transition-transform" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

import { useFonts } from 'expo-font';
import { Platform } from 'react-native';
import {
  Newsreader_300Light, Newsreader_400Regular, Newsreader_500Medium, Newsreader_600SemiBold,
} from '@expo-google-fonts/newsreader';
import {
  IBMPlexSans_300Light, IBMPlexSans_400Regular, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold,
} from '@expo-google-fonts/ibm-plex-sans';
import { type } from './tokens.js';

/**
 * Loading the type.
 *
 * This file exists because of a bug that only showed up when the app was
 * actually rendered rather than typechecked: every `fontFamily: 'Newsreader'`
 * in the design system resolved to nothing, because nothing ever loaded the
 * fonts. Everything fell back to one system face, which quietly erased the
 * serif/sans distinction the whole product leans on — the signal for "this part
 * is you" versus "this part is us". It compiled perfectly and looked wrong.
 *
 * React Native takes the WEIGHTED family name, not a family plus a numeric
 * weight, so each weight is registered under its own name and `weightedFamily`
 * below maps a (face, weight) pair onto the right one.
 */

export const FONTS = {
  Newsreader_300Light,
  Newsreader_400Regular,
  Newsreader_500Medium,
  Newsreader_600SemiBold,
  IBMPlexSans_300Light,
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
} as const;

export function useVigilFonts() {
  const [loaded, error] = useFonts(FONTS);
  return { loaded, error };
}

type Weight = '300' | '400' | '500' | '600';

const SERIF: Record<Weight, string> = {
  '300': 'Newsreader_300Light',
  '400': 'Newsreader_400Regular',
  '500': 'Newsreader_500Medium',
  '600': 'Newsreader_600SemiBold',
};

const SANS: Record<Weight, string> = {
  '300': 'IBMPlexSans_300Light',
  '400': 'IBMPlexSans_400Regular',
  '500': 'IBMPlexSans_500Medium',
  '600': 'IBMPlexSans_600SemiBold',
};

/**
 * On web a missing face falls through to the browser default, which is a SERIF
 * — so an unloaded sans role rendered as Times New Roman, and the distinction
 * the design depends on inverted itself silently. The fallback stack has to be
 * explicit, and it can only be attached on web: React Native native resolves a
 * single family name and treats a comma-separated stack as one unknown name.
 */
export function weightedFamily(face: 'serif' | 'sans', weight: string): string {
  const w = (['300', '400', '500', '600'].includes(weight) ? weight : '400') as Weight;
  const family = face === 'serif' ? SERIF[w] : SANS[w];
  if (Platform.OS !== 'web') return family;
  return `${family}, ${face === 'serif' ? type.serifFallback : type.sansFallback}`;
}

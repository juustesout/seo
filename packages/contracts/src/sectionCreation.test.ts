/**
 * Section creation parser tests (Part B Slice 2).
 *
 * The parser is conservative on purpose: it only recognizes an explicit
 * create-a-new-structure request and never invents a title. These tests pin the
 * trigger boundaries (a hero image is not a new hero) and the title extraction.
 */
import { describe, expect, it } from 'vitest';
import { sectionCreationFromInstruction } from './sectionCreation.js';

describe('sectionCreationFromInstruction', () => {
  it('reads a hero section with a quoted title and a background image', () => {
    expect(
      sectionCreationFromInstruction("Please add a hero section with a tilte 'halleluja' and background image of Amsterdam"),
    ).toEqual({ kind: 'hero', expectsHeading: true, heading: 'halleluja' });
  });

  it('reads an unquoted labelled title and stops it at a connector', () => {
    expect(sectionCreationFromInstruction('Add a hero section with the title Halleluja and a background of Amsterdam')).toEqual({
      kind: 'hero',
      expectsHeading: true,
      heading: 'Halleluja',
    });
  });

  it('reads a Dutch new-section request with a title', () => {
    expect(sectionCreationFromInstruction('Voeg een nieuwe sectie toe met de titel Over ons en een afbeelding')).toEqual({
      kind: 'section',
      expectsHeading: true,
      heading: 'Over ons',
    });
  });

  it('reads a new section without a title as a structure-only request', () => {
    expect(sectionCreationFromInstruction('add a new section')).toEqual({
      kind: 'section',
      expectsHeading: false,
    });
  });

  it('reads a bare new hero only when no image is asked for', () => {
    expect(sectionCreationFromInstruction("add a hero with the title 'Welkom'")).toEqual({
      kind: 'hero',
      expectsHeading: true,
      heading: 'Welkom',
    });
  });

  it('reports an asked-for title that cannot be read reliably', () => {
    expect(sectionCreationFromInstruction('add a hero section with a title')).toEqual({
      kind: 'hero',
      expectsHeading: true,
    });
  });

  it('does not read a quoted image subject as a title', () => {
    expect(sectionCreationFromInstruction("add a hero section with a background image of 'Amsterdam'")).toEqual({
      kind: 'hero',
      expectsHeading: false,
    });
  });

  it('reads a titled new section alongside a background', () => {
    expect(sectionCreationFromInstruction("add a section titled 'About' with a background image of Amsterdam")).toEqual({
      kind: 'section',
      expectsHeading: true,
      heading: 'About',
    });
  });

  it('does not treat an existing hero/section or an image request as creation', () => {
    expect(sectionCreationFromInstruction('Maak de hero sterker.')).toBeNull();
    expect(sectionCreationFromInstruction('The page already has a hero section.')).toBeNull();
    expect(sectionCreationFromInstruction('add a hero image to this page')).toBeNull();
    expect(sectionCreationFromInstruction('Add an inline image to this section')).toBeNull();
    expect(sectionCreationFromInstruction('Use a calm background here.')).toBeNull();
    expect(sectionCreationFromInstruction('')).toBeNull();
  });
});

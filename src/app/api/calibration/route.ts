// GET /api/calibration → active profile (seeds defaults on first call)
// PUT /api/calibration { name?, config } → upsert active profile (numbers 0..1)

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  ensureActiveCalibration,
  readJsonBody,
  serverError,
  validateCalibrationConfig,
} from '../_lib/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const profile = await ensureActiveCalibration();
    return NextResponse.json({
      id: profile.id,
      name: profile.name,
      active: profile.active,
      config: JSON.parse(profile.configJson),
      updatedAt: profile.updatedAt,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await readJsonBody(req);
    if (!body || body.config === undefined) {
      return NextResponse.json(
        { error: 'يجب إرسال الإعدادات في الحقل config' },
        { status: 400 }
      );
    }
    const config = validateCalibrationConfig(body.config);
    if (!config) {
      return NextResponse.json(
        {
          error:
            'إعدادات المعايرة غير صالحة — filled/empty/ambiguousMargin/minAbsoluteFill يجب أن تكون أرقامًا بين 0 و 1',
        },
        { status: 400 }
      );
    }
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : 'افتراضي — قلم رصاص';

    const existing = await db.calibrationProfile.findFirst({ where: { active: true } });
    const profile = existing
      ? await db.calibrationProfile.update({
          where: { id: existing.id },
          data: { name, configJson: JSON.stringify(config) },
        })
      : await db.calibrationProfile.create({
          data: { name, active: true, configJson: JSON.stringify(config) },
        });

    return NextResponse.json({
      id: profile.id,
      name: profile.name,
      active: profile.active,
      config: JSON.parse(profile.configJson),
      updatedAt: profile.updatedAt,
    });
  } catch (err) {
    return NextResponse.json(serverError(err), { status: 500 });
  }
}

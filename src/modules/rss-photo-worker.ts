import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);
process.once('message', (job: { source: Buffer; format: string; width: number; height: number; maxPixels: number; maxDimension: number }) => {
  const image = sharp(job.source, { limitInputPixels: job.maxPixels, failOn: 'warning', unlimited: false, sequentialRead: true }).timeout({ seconds: 10 });
  void (async () => {
    const metadata = await image.metadata();
    if (metadata.format !== job.format || metadata.width !== job.width || metadata.height !== job.height
      || (metadata.pages ?? 1) !== 1 || (metadata.pageHeight ?? metadata.height) !== metadata.height || (metadata.delay?.length ?? 0) > 1) throw new Error('INVALID_INPUT');
    const { data, info } = await image.autoOrient().resize({ width: job.maxDimension, height: job.maxDimension, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
    await new Promise<void>((resolve, reject) => process.send!({ data, width: info.width, height: info.height }, error => error ? reject(error) : resolve()));
  })().then(() => { image.destroy(); process.exit(0); }, () => { image.destroy(); process.exit(1); });
});

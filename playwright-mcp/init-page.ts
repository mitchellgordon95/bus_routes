// Set browser context to NYC (Times Square) for location-based searches
export default async ({ page }) => {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({
    latitude: 40.7580,
    longitude: -73.9855
  });
};

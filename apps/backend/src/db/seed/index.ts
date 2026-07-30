export const seed = async () => {
	console.info("Seeding database...");

	// No demo data to seed after the OneQ journal/prompt strip. The seed entry
	// point is kept so `yarn db seed` stays a valid no-op and future seeds have
	// a home.

	console.info("Seeding completed successfully!");
};

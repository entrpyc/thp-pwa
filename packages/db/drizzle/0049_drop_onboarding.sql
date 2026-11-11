-- Release notes replace the onboarding system. A notice that opened an onboarding now opens the
-- list of release notes: the page it named is gone, and a bell entry that lands on a 404 is worse
-- than one that lands on what is new.
UPDATE "notification" SET "href" = '/release-notes' WHERE "href" LIKE '/onboarding/%';--> statement-breakpoint
DROP TABLE "user_onboarding" CASCADE;--> statement-breakpoint
ALTER TABLE "announcement" DROP CONSTRAINT "announcement_onboarding_on_new_feature";--> statement-breakpoint
ALTER TABLE "announcement" DROP COLUMN "onboarding_id";

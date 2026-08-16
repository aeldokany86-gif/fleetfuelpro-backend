CREATE TYPE "MobilePhotoSourcePolicy" AS ENUM (
  'CAMERA_ONLY',
  'CAMERA_AND_GALLERY'
);

ALTER TABLE "Company"
ADD COLUMN "mobilePhotoSourcePolicy" "MobilePhotoSourcePolicy"
NOT NULL DEFAULT 'CAMERA_ONLY',
ADD COLUMN "saveCapturedPhotosToDeviceGallery" BOOLEAN
NOT NULL DEFAULT false;

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadsService } from './uploads.service';
import { UploadOperationPhotoDto } from './dto/upload-operation-photo.dto';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('operation-photo')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 8 * 1024 * 1024,
      },
      fileFilter: (_req, file, callback) => {
        if (!String(file.mimetype || '').startsWith('image/')) {
          return callback(new BadRequestException('Only image files are allowed.'), false);
        }

        return callback(null, true);
      },
    }),
  )
  uploadOperationPhoto(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadOperationPhotoDto,
  ) {
    return this.uploadsService.uploadOperationPhoto({
      file,
      companyId: dto.companyId,
      operationNo: dto.operationNo,
      ownerType: dto.ownerType || dto.entityType || '',
      ownerCode: dto.ownerCode || dto.entityCode || dto.ownerId || '',
      photoType: dto.photoType,
    });
  }

  @Get('signed-url')
  createSignedUrl(
    @Query('path') path: string,
    @Query('expiresIn') expiresIn?: string,
  ) {
    return this.uploadsService.createSignedUrl(path, Number(expiresIn) || 300);
  }
}

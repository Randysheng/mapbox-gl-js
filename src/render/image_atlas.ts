import assert from 'assert';
import {RGBAImage} from '../util/image';
import {register} from '../util/web_worker_transfer';
import potpack from 'potpack';
import {ImageIdWithOptions} from '../style-spec/expression/types/image_id_with_options';

import type {StyleImage, StyleImageMap} from '../style/style_image';
import type ImageManager from './image_manager';
import type Texture from './texture';
import type {SpritePosition} from '../util/image';
import type {LUT} from "../util/lut";

const ICON_PADDING: number = 1;
const PATTERN_PADDING: number = 2;
export {ICON_PADDING, PATTERN_PADDING};

type Rect = {
    x: number;
    y: number;
    w: number;
    h: number;
};

type ImagePositionScale = {
    x: number;
    y: number;
}

export type ImagePositionMap = Record<string, ImagePosition>;

export class ImagePosition implements SpritePosition {
    paddedRect: Rect;
    pixelRatio: number;
    version: number;
    stretchY: Array<[number, number]> | null | undefined;
    stretchX: Array<[number, number]> | null | undefined;
    content: [number, number, number, number] | null | undefined;
    padding: number;
    sdf: boolean;
    scale: ImagePositionScale;

    static getImagePositionScale(imageIdWithOptions: ImageIdWithOptions | undefined, usvg: boolean, pixelRatio: number): ImagePositionScale {
        if (usvg && imageIdWithOptions && imageIdWithOptions.options && imageIdWithOptions.options.transform) {
            return {
                x: imageIdWithOptions.options.transform.a,
                y: imageIdWithOptions.options.transform.d
            };
        } else {
            return {
                x: pixelRatio,
                y: pixelRatio
            };
        }
    }

    constructor(paddedRect: Rect, image: StyleImage, padding: number, imageIdWithOptions?: ImageIdWithOptions) {
        this.paddedRect = paddedRect;
        const {
            pixelRatio,
            version,
            stretchX,
            stretchY,
            content,
            sdf,
            usvg,
        } = image;

        this.pixelRatio = pixelRatio;
        this.stretchX = stretchX;
        this.stretchY = stretchY;
        this.content = content;
        this.version = version;
        this.padding = padding;
        this.sdf = sdf;
        this.scale = ImagePosition.getImagePositionScale(imageIdWithOptions, usvg, pixelRatio);
    }

    get tl(): [number, number] {
        return [
            this.paddedRect.x + this.padding,
            this.paddedRect.y + this.padding
        ];
    }

    get br(): [number, number] {
        return [
            this.paddedRect.x + this.paddedRect.w - this.padding,
            this.paddedRect.y + this.paddedRect.h - this.padding
        ];
    }

    get displaySize(): [number, number] {
        return [
            (this.paddedRect.w - this.padding * 2) / this.scale.x,
            (this.paddedRect.h - this.padding * 2) / this.scale.y
        ];
    }
}

function getImageBin(image: StyleImage, padding: number, scale: [number, number] = [1, 1]) {
    // If it's a vector image, we set it's size as the natural one scaled
    const imageWidth = image.data ? image.data.width : image.width * scale[0];
    const imageHeight = image.data ? image.data.height : image.height * scale[1];
    return {
        x: 0,
        y: 0,
        w: imageWidth + 2 * padding,
        h: imageHeight + 2 * padding,
    };
}

export function getImagePosition(id: string, src: StyleImage, padding: number) {
    const imageIdWithOptions = ImageIdWithOptions.deserializeFromString(id);
    const bin = getImageBin(src, padding, [imageIdWithOptions.options.transform.a, imageIdWithOptions.options.transform.d]);
    return {bin, imagePosition: new ImagePosition(bin, src, padding, imageIdWithOptions), imageIdWithOptions};
}

export default class ImageAtlas {
    image: RGBAImage;
    iconPositions: ImagePositionMap;
    patternPositions: ImagePositionMap;
    haveRenderCallbacks: Array<string>;
    uploaded: boolean | null | undefined;
    lut: LUT | null;

    constructor(icons: StyleImageMap, patterns: StyleImageMap, lut: LUT | null) {
        const iconPositions: ImagePositionMap = {};
        const patternPositions: ImagePositionMap = {};
        this.haveRenderCallbacks = [];

        const bins = [];

        this.addImages(icons, iconPositions, ICON_PADDING, bins);
        this.addImages(patterns, patternPositions, PATTERN_PADDING, bins);

        const {w, h} = potpack(bins);
        const image = new RGBAImage({width: w || 1, height: h || 1});

        for (const id in icons) {
            const src = icons[id];
            const bin = iconPositions[id].paddedRect;
            // For SDF icons, we override the RGB channels with white.
            // This is because we read the red channel in the shader and RGB channels will get alpha-premultiplied on upload.
            const overrideRGB = src.sdf;
            RGBAImage.copy(src.data, image, {x: 0, y: 0}, {x: bin.x + ICON_PADDING, y: bin.y + ICON_PADDING}, src.data, lut, overrideRGB);
        }

        for (const id in patterns) {
            const src = patterns[id];
            const bin = patternPositions[id].paddedRect;
            let padding = patternPositions[id].padding;
            const x = bin.x + padding,
                y = bin.y + padding,
                w = src.data.width,
                h = src.data.height;

            assert(padding > 1);
            padding = padding > 1 ? padding - 1 : padding;

            RGBAImage.copy(src.data, image, {x: 0, y: 0}, {x, y}, src.data, lut);
            // Add wrapped padding on each side of the image.
            // Leave one pixel transparent to avoid bleeding to neighbouring images
            RGBAImage.copy(src.data, image, {x: 0, y: h - padding}, {x, y: y - padding}, {width: w, height: padding}, lut); // T
            RGBAImage.copy(src.data, image, {x: 0, y:     0}, {x, y: y + h}, {width: w, height: padding}, lut); // B
            RGBAImage.copy(src.data, image, {x: w - padding, y: 0}, {x: x - padding, y}, {width: padding, height: h}, lut); // L
            RGBAImage.copy(src.data, image, {x: 0,     y: 0}, {x: x + w, y}, {width: padding, height: h}, lut); // R
            // Fill corners
            RGBAImage.copy(src.data, image, {x: w - padding, y: h - padding}, {x: x - padding, y: y - padding}, {width: padding, height: padding}, lut); // TL
            RGBAImage.copy(src.data, image, {x: 0, y: h - padding}, {x: x + w, y: y - padding}, {width: padding, height: padding}, lut); // TR
            RGBAImage.copy(src.data, image, {x: 0, y: 0}, {x: x + w, y: y + h}, {width: padding, height: padding}, lut); // BL
            RGBAImage.copy(src.data, image, {x: w - padding, y: 0}, {x: x - padding, y: y + h}, {width: padding, height: padding}, lut); // BR
        }

        this.lut = lut;
        this.image = image;
        this.iconPositions = iconPositions;
        this.patternPositions = patternPositions;
    }

    addImages(images: StyleImageMap, positions: ImagePositionMap, padding: number, bins: Array<Rect>) {
        for (const id in images) {
            const src = images[id];
            const {bin, imagePosition, imageIdWithOptions} = getImagePosition(id, src, padding);
            positions[id] = imagePosition;
            bins.push(bin);

            if (src.hasRenderCallback) {
                this.haveRenderCallbacks.push(imageIdWithOptions.id);
            }
        }
    }

    patchUpdatedImages(imageManager: ImageManager, texture: Texture, scope: string) {
        this.haveRenderCallbacks = this.haveRenderCallbacks.filter(id => imageManager.hasImage(id, scope));
        imageManager.dispatchRenderCallbacks(this.haveRenderCallbacks, scope);

        for (const name in imageManager.getUpdatedImages(scope)) {
            for (const id of Object.keys(this.iconPositions)) {
                if (ImageIdWithOptions.deserializeId(id) === name) {
                    this.patchUpdatedImage(this.iconPositions[id], imageManager.getImage(name, scope), texture);
                }
            }

            for (const id of Object.keys(this.patternPositions)) {
                if (ImageIdWithOptions.deserializeId(id) === name) {
                    this.patchUpdatedImage(this.patternPositions[id], imageManager.getImage(name, scope), texture);
                }
            }
        }
    }

    patchUpdatedImage(position: ImagePosition | null | undefined, image: StyleImage | null | undefined, texture: Texture) {
        if (!position || !image) return;

        if (position.version === image.version) return;

        position.version = image.version;
        const [x, y] = position.tl;
        const overrideRGBWithWhite = position.sdf;
        if (this.lut || overrideRGBWithWhite) {
            const size = {width: image.data.width, height: image.data.height};
            const imageToUpload = new RGBAImage(size);
            RGBAImage.copy(image.data, imageToUpload, {x: 0, y: 0}, {x: 0, y: 0}, size, this.lut, overrideRGBWithWhite);
            texture.update(imageToUpload, {position: {x, y}});
        } else {
            texture.update(image.data, {position: {x, y}});
        }
    }

}

register(ImagePosition, 'ImagePosition');
register(ImageAtlas, 'ImageAtlas');
